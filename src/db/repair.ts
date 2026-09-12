import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Creates/repairs operational tables that can be absent or older than the
 * application schema. Safe to run repeatedly against an existing database.
 */
export async function repairOperationalSchema() {
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
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS job_dedupe_uq ON jobs (dedupe_key);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS job_poll_idx ON jobs (status, run_at);`);

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
      project_id text NOT NULL,
      deployment_id text NOT NULL,
      driver text NOT NULL,
      host_id text NOT NULL DEFAULT 'local',
      external_id text NOT NULL,
      port integer NOT NULL,
      status text NOT NULL DEFAULT 'running',
      pid integer,
      started_at timestamptz NOT NULL DEFAULT now(),
      stopped_at timestamptz,
      last_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Older deployments used started_at but the current Drizzle schema queries created_at.
  // Add the current column without destroying legacy data.
  await db.execute(sql`ALTER TABLE container_instances ADD COLUMN IF NOT EXISTS created_at timestamptz;`);
  await db.execute(sql`UPDATE container_instances SET created_at = COALESCE(created_at, started_at, now()) WHERE created_at IS NULL;`);
  await db.execute(sql`ALTER TABLE container_instances ALTER COLUMN created_at SET DEFAULT now();`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS container_project_idx ON container_instances (project_id, status);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS container_created_idx ON container_instances (created_at DESC);`);
}
