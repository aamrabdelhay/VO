import pg from "pg";

if (process.env.VERCEL !== "1") process.exit(0);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for the Vercel database bootstrap");

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  // These are the only tables created by our temporary repair layer. The
  // production schema will recreate them with the canonical Drizzle definition.
  await client.query(`DROP TABLE IF EXISTS job_runs, jobs, container_instances CASCADE`);
  await client.query(`DROP TYPE IF EXISTS job_status CASCADE`);
} finally {
  await client.end().catch(() => {});
}
