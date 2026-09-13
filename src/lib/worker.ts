import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments, projects } from "@/db/schema";
import { runAllCleanup } from "@/lib/cleanup";
import {
  drainDeployment,
  expirePreview,
  monitorAfterPromotion,
  runDeploymentPipeline,
} from "@/lib/deploy";
import { diagnoseDeployment, runFixLoop } from "@/lib/ai/agent";
import { executeGarvexJob } from "@/lib/ai/garvex-queue";
import { log } from "@/lib/logger";
import { claimNextJob, completeJob, enqueue, failJob, recoverStaleJobs, type JobRecord } from "@/lib/queue";
import { collectMetrics, reconcile } from "@/lib/reconciler";
import { processWebhook } from "@/lib/webhooks";
import { verifyDomain } from "@/lib/domains";
import { shouldUseVercelHosting, startVercelDeployment } from "@/lib/vercel-hosting";
import { transition } from "@/lib/state-machine";

const WORKER_ID = `${process.env.PLATFORM_HOST_ID ?? "local"}-${randomUUID().slice(0, 8)}`;

type Handler = (payload: Record<string, unknown>, job: JobRecord) => Promise<unknown>;

async function runDeploymentJob(deploymentId: string) {
  if (!shouldUseVercelHosting()) return runDeploymentPipeline(deploymentId);
  const [deployment] = await db.select().from(deployments).where(eq(deployments.id, deploymentId)).limit(1);
  if (!deployment) throw new Error("Deployment not found");
  const [project] = await db.select().from(projects).where(eq(projects.id, deployment.projectId)).limit(1);
  if (!project) throw new Error("Project not found");
  if (deployment.status !== "QUEUED") return { ok: false, reason: `deployment already ${deployment.status}` };
  try {
    await transition(
      deployment.id,
      "BUILDING",
      { buildStartedAt: new Date() },
      { event: "VERCEL_BUILD_STARTED", message: "Deployment handed to Vercel hosting" },
    );
    return await startVercelDeployment(project, { ...deployment, status: "BUILDING" });
  } catch (error) {
    await transition(
      deployment.id,
      "FAILED",
      { finishedAt: new Date(), errorReason: error instanceof Error ? error.message : String(error) },
      { event: "VERCEL_HANDOFF_FAILED", message: error instanceof Error ? error.message : String(error) },
    );
    throw error;
  }
}

export const handlers: Record<string, Handler> = {
  deploy: async (payload) => {
    if (payload.action === "drain") {
      await drainDeployment(String(payload.deploymentId));
      return { drained: payload.deploymentId };
    }
    return runDeploymentJob(String(payload.deploymentId));
  },
  build: async (payload) => runDeploymentJob(String(payload.deploymentId)),
  "post-promotion-monitor": async (payload) =>
    monitorAfterPromotion(String(payload.deploymentId), Number(payload.until)),
  "preview-expire": async (payload) =>
    expirePreview(String(payload.deploymentId), "retention policy"),
  "webhook-process": async (payload) => processWebhook(String(payload.deliveryId)),
  cleanup: async () => runAllCleanup(),
  reconcile: async () => reconcile(),
  "metrics-collect": async () => collectMetrics(),
  "domain-verify": async (payload) => verifyDomain(String(payload.domainId)),
  "ai-diagnose": async (payload) => diagnoseDeployment(String(payload.deploymentId), "system"),
  "ai-fix": async (payload) => runFixLoop(String(payload.deploymentId), String(payload.actor ?? "system")),
  "ai-garvex": async (_payload, job) => executeGarvexJob(job),
  "health-check": async () => reconcile(),
};

export async function runOneJob(): Promise<boolean> {
  const job = await claimNextJob(WORKER_ID);
  if (!job) return false;
  const started = Date.now();
  const handler = handlers[job.type];
  const ctx = { jobId: job.id, projectId: job.projectId ?? undefined, service: "worker" };
  if (!handler) {
    await failJob(job, new Error(`No handler for job type ${job.type}`), 0, WORKER_ID, { retryable: false });
    return true;
  }
  try {
    log.info(`Job started: ${job.type}`, ctx);
    const result = await handler((job.payload ?? {}) as Record<string, unknown>, job);
    await completeJob(job, Date.now() - started, WORKER_ID);
    log.info(`Job finished: ${job.type}`, { ...ctx, result: JSON.stringify(result).slice(0, 300) });
  } catch (error) {
    log.error(`Job failed: ${job.type}`, { ...ctx, error: String(error) });
    await failJob(job, error, Date.now() - started, WORKER_ID);
  }
  return true;
}

export async function drainQueue(maxJobs = 5) {
  let processed = 0;
  while (processed < maxJobs) {
    const worked = await runOneJob();
    if (!worked) break;
    processed += 1;
  }
  return processed;
}

let loopStarted = false;

export function startWorkerLoop() {
  if (loopStarted) return;
  loopStarted = true;
  log.info("Worker loop starting", { workerId: WORKER_ID, service: "worker" });

  const tick = async () => {
    try { await drainQueue(3); }
    catch (error) { log.error("Worker tick failed", { error: String(error), service: "worker" }); }
  };

  const schedule = async () => {
    try {
      await recoverStaleJobs();
      const bucket = Math.floor(Date.now() / 60_000);
      await enqueue({ type: "reconcile", payload: {}, dedupeKey: `reconcile:${bucket}`, maxAttempts: 1 });
      await enqueue({ type: "metrics-collect", payload: {}, dedupeKey: `metrics:${bucket}`, maxAttempts: 1 });
      await enqueue({ type: "cleanup", payload: {}, dedupeKey: `cleanup:${Math.floor(Date.now() / (30 * 60_000))}`, maxAttempts: 1 });
    } catch (error) { log.warn("Scheduler tick failed", { error: String(error), service: "worker" }); }
  };

  setInterval(tick, 2000).unref?.();
  setInterval(schedule, 60_000).unref?.();
  setTimeout(schedule, 5_000).unref?.();
}
