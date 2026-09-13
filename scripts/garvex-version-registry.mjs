import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl });
await pool.query(`
  create table if not exists garvex_agent_versions (
    id bigserial primary key,
    version text not null unique,
    model text not null,
    system_prompt text not null,
    benchmark_score numeric,
    status text not null default 'CANDIDATE',
    parent_version text,
    created_at timestamptz not null default now(),
    promoted_at timestamptz
  );
  create index if not exists garvex_agent_versions_status_idx on garvex_agent_versions(status);
`);

const model = process.env.GARVEX_LOCAL_MODEL ?? "qwen2.5:7b";
const prompt = process.env.GARVEX_LOCAL_SYSTEM_PROMPT ?? "You are Garvex Local. Follow user constraints exactly. Do not use external AI APIs. Preserve existing behavior. Never claim an action was completed without evidence.";
const score = process.env.GARVEX_BENCHMARK_SCORE == null ? null : Number(process.env.GARVEX_BENCHMARK_SCORE);
const parent = process.env.GARVEX_PARENT_VERSION ?? null;
const version = process.env.GARVEX_VERSION ?? `local-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;

await pool.query(
  `insert into garvex_agent_versions (version,model,system_prompt,benchmark_score,status,parent_version) values ($1,$2,$3,$4,'CANDIDATE',$5) on conflict (version) do update set benchmark_score=excluded.benchmark_score`,
  [version, model, prompt, score, parent],
);
console.log(JSON.stringify({ ok: true, version, model, benchmarkScore: score, status: "CANDIDATE" }));
await pool.end();
