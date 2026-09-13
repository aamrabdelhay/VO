import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns, jobs } from "@/db/schema";
import { log } from "@/lib/logger";

export type JobType =
  | "build"
  | "deploy"
  | "health-check"
  | "post-promotion-monitor"
  | "cleanup"
  | "preview-expire"
  | "webhook-process"
  | "reconcile"
  | "ai-diagnose"
  | "ai-fix"
  | "ai-garvex"
  | "metrics-collect"
  | "domain-verify";

export type JobRecord = typeof jobs.$inferSelect;

export type EnqueueOptions = {
  type: JobType;
  payload: Record<string, unknown>;
  /** Idempotency key: enqueueing the same key twice does not duplicate work. */
  dedupeKey?: string;
  queue?: string;
  runAt?: Date;
  maxAttempts?: number;
  priority?: number;
  projectId?: string | null;
  correlationId?: string | null;
};

export async function enqueue(opts: EnqueueOptions): Promise<JobRecord | null> {
  const values = {
    type: opts.type,
    queue: opts.queue ?? opts.type,
    payload: opts.payload,
    dedupeKey: opts.dedupeKey ?? null,
    runAt: opts.runAt ?? new Date(),
    maxAttempts: opts.maxAttempts ?? 3,
    priority: opts.priority ?? 100,
    projectId: opts.projectId ?? null,
    correlationId: opts.correlationId ?? null,
  };

  if (opts.dedupeKey) {
    const inserted = await db.insert(jobs).values(values).onConflictDoNothing().returning();
    if (inserted.length === 0) {
      log.info("Duplicate job suppressed", { type: opts.type, dedupeKey: opts.dedupeKey });
      return null;
    }
    return inserted[0];
  }
  const [row] = await db.insert(jobs).values(values).returning();
  return row;
}

/**
 * Claim the next due job. AI requests are isolated into a durable queue and
 * guarded by a Postgres advisory transaction lock so multiple Vercel instances
 * cannot concurrently consume the same AI rate-limit bucket.
 */
export async function claimNextJob(workerId: string, queue?: string): Promise<JobRecord | null> {
  if (queue === "garvex-ai") {
    const minIntervalMs = Math.max(250, Number(process.env.GARVEX_AI_MIN_INTERVAL_MS ?? 1200));
    const rows = await db.execute<JobRecord>(sql`
      with gate as (
        select pg_try_advisory_xact_lock(hashtextextended('vo.garvex.ai', 0)) as acquired
      ), candidate as (
        select j.id
        from jobs j
        cross join gate g
        where g.acquired
          and j.queue = ${queue}
          and j.status = 'QUEUED'
          and j.run_at <= now()
          and not exists (
            select 1 from jobs running
            where running.queue = ${queue} and running.status = 'RUNNING'
          )
          and not exists (
            select 1
            from job_runs recent_runs
            join jobs recent_jobs on recent_jobs.id = recent_runs.job_id
            where recent_jobs.queue = ${queue}
              and recent_runs.created_at > now() - (${minIntervalMs} * interval '1 millisecond')
          )
        order by j.priority desc, j.run_at asc, j.created_at asc
        for update skip locked
        limit 1
      )
      update jobs
      set status = 'RUNNING',
          locked_at = now(),
          locked_by = ${workerId},
          attempts = attempts + 1,
          updated_at = now()
      where id = (select id from candidate)
      returning *;
    `);
    return (rows.rows ?? [])[0] as JobRecord | undefined ?? null;
  }

  const rows = await db.execute<JobRecord>(sql`
    update jobs set status = 'RUNNING',
                    locked_at = now(),
                    locked_by = ${workerId},
                    attempts = attempts + 1,
                    updated_at = now()
    where id = (
      select id from jobs
      where status = 'QUEUED'
        ${queue ? sql`and queue = ${queue}` : sql``}
        and run_at <= now()
      order by priority desc, run_at asc, created_at asc
      for update skip locked
      limit 1
    )
    returning *;
  `);
  const row = (rows.rows ?? [])[0];
  return (row as JobRecord | undefined) ?? null;
}

export async function completeJob(job: JobRecord, durationMs: number, workerId: string) {
  await db
    .update(jobs)
    .set({ status: "SUCCEEDED", finishedAt: new Date(), updatedAt: new Date(), lastError: null })
    .where(eq(jobs.id, job.id));
  await db.insert(jobRuns).values({ jobId: job.id, attempt: job.attempts, ok: true, durationMs, workerId });
}

export async function failJob(
  job: JobRecord,
  error: unknown,
  durationMs: number,
  workerId: string,
  opts: { retryable?: boolean; retryAfterMs?: number } = {},
) {
  const message = error instanceof Error ? error.message : String(error);
  const retryable = opts.retryable ?? true;
  const exhausted = !retryable || job.attempts >= job.maxAttempts;
  const backoffMs = opts.retryAfterMs ?? Math.min(5 * 60_000, 2 ** job.attempts * 1000);
  await db
    .update(jobs)
    .set({
      status: exhausted ? "DEAD" : "QUEUED",
      lastError: message.slice(0, 2000),
      runAt: exhausted ? job.runAt : new Date(Date.now() + backoffMs),
      finishedAt: exhausted ? new Date() : null,
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));
  await db.insert(jobRuns).values({
    jobId: job.id,
    attempt: job.attempts,
    ok: false,
    error: message.slice(0, 2000),
    durationMs,
    workerId,
  });
}

/** Requeue jobs whose worker died mid-run (crash recovery). */
export async function recoverStaleJobs(staleMs = 10 * 60 * 1000) {
  const cutoff = new Date(Date.now() - staleMs);
  const recovered = await db
    .update(jobs)
    .set({ status: "QUEUED", lockedBy: null, lockedAt: null, updatedAt: new Date() })
    .where(and(eq(jobs.status, "RUNNING"), lte(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id });
  if (recovered.length) log.warn("Recovered stale jobs after worker restart", { count: recovered.length });
  return recovered.length;
}

export async function cancelJobsFor(projectId: string, types: JobType[]) {
  return db
    .update(jobs)
    .set({ status: "CANCELED", updatedAt: new Date(), finishedAt: new Date() })
    .where(and(eq(jobs.projectId, projectId), eq(jobs.status, "QUEUED"), inArray(jobs.type, types)))
    .returning({ id: jobs.id });
}

export async function listJobs(limit = 50) {
  return db.select().from(jobs).orderBy(asc(jobs.status), sql`updated_at desc`).limit(limit);
}
