import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLogs,
  cleanupRuns,
  containerInstances,
  deployments,
  domains,
  hosts,
  incidents,
  jobs,
  organizations,
  projects,
  users,
} from "@/db/schema";
import { handle, ok, readJson } from "@/lib/api";
import { assertCsrf, HttpError, requirePlatformAdmin } from "@/lib/auth";
import { runAllCleanup, storageUsage } from "@/lib/cleanup";
import { reconcile } from "@/lib/reconciler";
import { drainQueue } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    await requirePlatformAdmin();
    const [counts] = await db
      .select({
        users: sql<number>`(select count(*) from ${users})`,
        orgs: sql<number>`(select count(*) from ${organizations})`,
        projects: sql<number>`(select count(*) from ${projects})`,
        deployments: sql<number>`(select count(*) from ${deployments})`,
        running: sql<number>`(select count(*) from ${containerInstances} where status = 'running')`,
        failed: sql<number>`(select count(*) from ${deployments} where status = 'FAILED')`,
        domains: sql<number>`(select count(*) from ${domains})`,
      })
      .from(sql`(select 1) as t`);

    const queue = await db
      .select({ status: jobs.status, type: jobs.type, count: sql<number>`count(*)` })
      .from(jobs)
      .groupBy(jobs.status, jobs.type);
    const deadJobs = await db
      .select()
      .from(jobs)
      .where(eq(jobs.status, "DEAD"))
      .orderBy(desc(jobs.updatedAt))
      .limit(20);
    const recentJobs = await db.select().from(jobs).orderBy(desc(jobs.updatedAt)).limit(20);
    const hostRows = await db.select().from(hosts);
    const cleanups = await db.select().from(cleanupRuns).orderBy(desc(cleanupRuns.startedAt)).limit(10);
    const audits = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(30);
    const openIncidents = await db.select().from(incidents).orderBy(desc(incidents.startedAt)).limit(10);
    const storage = await storageUsage();

    return ok({
      counts,
      queue,
      deadJobs,
      recentJobs,
      hosts: hostRows,
      cleanups,
      audits,
      incidents: openIncidents,
      storage,
    });
  });
}

type Body = { action: "cleanup" | "reconcile" | "drain-queue" | "retry-job"; jobId?: string };

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const body = await readJson<Body>(request);

    switch (body.action) {
      case "cleanup":
        return ok({ results: await runAllCleanup() });
      case "reconcile":
        return ok({ actions: await reconcile() });
      case "drain-queue":
        return ok({ processed: await drainQueue(10) });
      case "retry-job": {
        if (!body.jobId) throw new HttpError(400, "jobId required");
        const [job] = await db
          .update(jobs)
          .set({ status: "QUEUED", attempts: 0, runAt: new Date(), lastError: null })
          .where(eq(jobs.id, body.jobId))
          .returning();
        if (!job) throw new HttpError(404, "Job not found");
        return ok({ job });
      }
      default:
        throw new HttpError(400, "Unsupported action");
    }
  });
}
