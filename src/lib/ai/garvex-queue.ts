import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { claimNextJob, completeJob, enqueue, failJob, type JobRecord } from "@/lib/queue";
import { multiAgentComplete, type ChatMessage } from "@/lib/ai/provider";

const WORKER_ID_PREFIX = process.env.PLATFORM_HOST_ID ?? "garvex-http";
const MAX_INLINE_DRAIN_MS = Math.max(5000, Number(process.env.GARVEX_INLINE_DRAIN_MS ?? 25000));

type GarvexJobPayload = {
  messages: ChatMessage[];
  maxWorkers?: number;
  timeoutMs?: number;
  quorum?: number;
  strategy?: "single" | "complex";
  result?: Awaited<ReturnType<typeof multiAgentComplete>>;
};

export async function executeGarvexJob(job: JobRecord) {
  const payload = job.payload as GarvexJobPayload;
  if (!Array.isArray(payload.messages)) throw new Error("Invalid Garvex queue payload: messages missing");
  const result = await multiAgentComplete(payload.messages, {
    maxWorkers: payload.maxWorkers,
    timeoutMs: payload.timeoutMs,
    quorum: payload.quorum,
    strategy: payload.strategy,
  });
  await db
    .update(jobs)
    .set({ payload: { ...payload, result } as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(jobs.id, job.id));
  return result;
}

async function readJob(id: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return job ?? null;
}

export async function queuedGarvexComplete(messages: ChatMessage[], opts?: { maxWorkers?: number; timeoutMs?: number; quorum?: number; strategy?: "single" | "complex" }) {
  const job = await enqueue({
    type: "ai-garvex",
    queue: "garvex-ai",
    payload: { messages, maxWorkers: opts?.maxWorkers, timeoutMs: opts?.timeoutMs, quorum: opts?.quorum, strategy: opts?.strategy },
    priority: 1000,
    maxAttempts: 3,
  });
  if (!job) throw new Error("Garvex request could not be queued.");

  const workerId = `${WORKER_ID_PREFIX}-${randomUUID().slice(0, 8)}`;
  const deadline = Date.now() + MAX_INLINE_DRAIN_MS;
  while (Date.now() < deadline) {
    const current = await readJob(job.id);
    if (current?.status === "SUCCEEDED") {
      const result = (current.payload as GarvexJobPayload).result;
      if (result) return result;
    }
    if (current?.status === "DEAD" || current?.status === "CANCELED") {
      throw new Error(current.lastError ?? "Garvex queue job did not complete.");
    }

    const claimed = await claimNextJob(workerId, "garvex-ai");
    if (claimed) {
      const started = Date.now();
      try {
        const result = await executeGarvexJob(claimed);
        await completeJob(claimed, Date.now() - started, workerId);
        if (claimed.id === job.id) return result;
      } catch (error) {
        await failJob(claimed, error, Date.now() - started, workerId);
        if (claimed.id === job.id) throw error;
      }
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Garvex request is queued and rate-limited. Retry shortly; the durable queue retained the request.");
}
