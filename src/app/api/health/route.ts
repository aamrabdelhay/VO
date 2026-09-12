import { sql } from "drizzle-orm";
import { db } from "@/db";
import { containerInstances, jobs } from "@/db/schema";
import { getRuntimeDriver } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  try {
    await db.execute(sql`select 1`);
    checks.database = { ok: true };
  } catch (error) {
    checks.database = { ok: false, detail: String(error) };
  }
  try {
    const [row] = await db
      .select({ queued: sql<number>`count(*) filter (where status = 'QUEUED')` })
      .from(jobs);
    checks.queue = { ok: true, detail: `${Number(row?.queued ?? 0)} queued` };
  } catch (error) {
    checks.queue = { ok: false, detail: String(error) };
  }
  try {
    const driver = await getRuntimeDriver();
    const [row] = await db
      .select({ running: sql<number>`count(*) filter (where status = 'running')` })
      .from(containerInstances);
    checks.dataPlane = {
      ok: true,
      detail: `${driver.name} driver, ${Number(row?.running ?? 0)} runtimes`,
    };
  } catch (error) {
    checks.dataPlane = { ok: false, detail: String(error) };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return Response.json(
    { status: ok ? "ok" : "degraded", checks, timestamp: new Date().toISOString() },
    { status: ok ? 200 : 503 },
  );
}
