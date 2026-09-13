import pg from "pg";

if (process.env.VERCEL !== "1") process.exit(0);

const url = process.env.DATABASE_URL;
// Vercel can run a build without exposing a runtime-only database secret. The
// application still requires DATABASE_URL at runtime; the bootstrap is simply
// skipped during builds when the secret is not available to the build worker.
if (!url) {
  console.warn("[vo] DATABASE_URL is not available during the Vercel build; skipping database bootstrap.");
  process.exit(0);
}

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('vo.vercel_db_prepare', 0))`);
  await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS free_domain text`);
  await client.query(`UPDATE projects SET free_domain = lower(regexp_replace(trim(slug), '[^a-zA-Z0-9-]', '-', 'g')) WHERE free_domain IS NULL OR free_domain = ''`);
  await client.query(`ALTER TABLE projects ALTER COLUMN free_domain SET NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS projects_free_domain_uq ON projects (free_domain)`);
  await client.query(`
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
  await client.query(`CREATE INDEX IF NOT EXISTS container_project_idx ON container_instances(project_id, status)`);
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end().catch(() => {});
}
