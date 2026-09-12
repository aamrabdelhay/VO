import pg from "pg";

if (process.env.VERCEL !== "1") process.exit(0);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for the Vercel database bootstrap");

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  // Keep the live database intact. Only apply the small additive compatibility
  // change needed by the hosted control plane; never drop operational tables
  // during a Vercel build.
  await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS free_domain text`);
  await client.query(`UPDATE projects SET free_domain = lower(regexp_replace(trim(slug), '[^a-zA-Z0-9-]', '-', 'g')) WHERE free_domain IS NULL OR free_domain = ''`);
  await client.query(`ALTER TABLE projects ALTER COLUMN free_domain SET NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS projects_free_domain_uq ON projects (free_domain)`);
} finally {
  await client.end().catch(() => {});
}