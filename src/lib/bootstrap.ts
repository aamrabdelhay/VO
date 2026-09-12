import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { hosts, organizations, users } from "@/db/schema";
import { createUser } from "@/lib/auth";
import { log } from "@/lib/logger";
import { getRuntimeDriver } from "@/lib/runtime";

let done = false;

/**
 * Repairs the small operational slice of the database that may be missing when
 * an older database is connected to a newer application revision.
 * All statements are idempotent and only create missing database objects.
 */
async function repairOperationalSchema() {
  await db.execute(sql`
    DO $$
    BEGIN
      CREATE TYPE job_status AS ENUM ('QUEUED','RUNNING','SUCCEEDED','FAILED','DEAD','CANCELED');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      type text NOT NULL,
      queue text NOT NULL DEFAULT 'default',
      dedupe_key text,
      payload jsonb NOT NULL,
      status job_status NOT NULL DEFAULT 'QUEUED',
      priority integer NOT NULL DEFAULT 100,
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      run_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz,
      locked_by text,
      last_error text,
      project_id text,
      correlation_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    );
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS job_dedupe_uq ON jobs (dedupe_key);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS job_poll_idx ON jobs (status, run_at);
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS job_runs (
      id text PRIMARY KEY,
      job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      attempt integer NOT NULL,
      ok boolean NOT NULL,
      error text,
      duration_ms integer,
      worker_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS container_instances (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      deployment_id text NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      driver text NOT NULL,
      host_id text NOT NULL DEFAULT 'local',
      external_id text NOT NULL,
      port integer NOT NULL,
      status text NOT NULL DEFAULT 'running',
      pid integer,
      started_at timestamptz NOT NULL DEFAULT now(),
      stopped_at timestamptz,
      last_seen_at timestamptz
    );
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS container_project_idx ON container_instances (project_id, status);
  `);
}

/** Idempotent first-run setup: owner account, default org, host registration. */
export async function bootstrapPlatform() {
  if (done) return;
  done = true;

  await db.execute(sql`select 1`);
  await repairOperationalSchema();

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(users);
  if (Number(count) === 0) {
    const email = process.env.PLATFORM_ADMIN_EMAIL ?? "admin@platform.local";
    const password = process.env.PLATFORM_ADMIN_PASSWORD ?? "platform-admin";
    const { user } = await createUser(email, "Platform Owner", password);
    await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));
    log.info("Bootstrapped platform owner account", { email });
  }

  const [org] = await db.select().from(organizations).limit(1);
  const driver = await getRuntimeDriver();
  await db
    .insert(hosts)
    .values({
      id: process.env.PLATFORM_HOST_ID ?? "local",
      region: process.env.PLATFORM_REGION ?? "local",
      driver: driver.name,
      healthy: true,
      lastHeartbeatAt: new Date(),
    })
    .onConflictDoUpdate({
      target: hosts.id,
      set: { healthy: true, driver: driver.name, lastHeartbeatAt: new Date() },
    });

  log.info("Platform bootstrap complete", { orgId: org?.id, runtimeDriver: driver.name });
}
