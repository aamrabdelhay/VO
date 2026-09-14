import { timingSafeEqual } from "node:crypto";
import { drainQueue } from "@/lib/worker";
import { enqueue, recoverStaleJobs } from "@/lib/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorized(request: Request) {
  const expected = process.env.WORKER_TICK_SECRET ?? process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  const provided = request.headers.get("x-worker-tick-secret") ?? (authorization?.startsWith("Bearer ") ? authorization.slice(7) : null);
  if (!expected || !provided) return false;
  const a = Buffer.from(expected); const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function tick(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await recoverStaleJobs();
    const bucket = Math.floor(Date.now() / 60_000);
    await enqueue({ type: "reconcile", payload: {}, dedupeKey: `reconcile:${bucket}`, maxAttempts: 1 });
    await enqueue({ type: "metrics-collect", payload: {}, dedupeKey: `metrics:${bucket}`, maxAttempts: 1 });
    await enqueue({ type: "cleanup", payload: {}, dedupeKey: `cleanup:${Math.floor(Date.now() / (30 * 60_000))}`, maxAttempts: 1 });
    if (process.env.SELF_PRACTICE_ENABLED === "1") {
      const practiceBucket = Math.floor(Date.now() / (15 * 60_000));
      await enqueue({
        type: "self-practice",
        queue: "self-practice",
        payload: {},
        dedupeKey: `self-practice:${practiceBucket}`,
        maxAttempts: 1,
        priority: 25,
      });
    }
    const processed = await drainQueue(5);
    return Response.json({ ok: true, processed, scheduler: "cron", note: "Vercel cron runs at minute granularity; jobs can wait roughly up to 60 seconds when traffic is low." });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function GET(request: Request) { return tick(request); }
export async function POST(request: Request) { return tick(request); }