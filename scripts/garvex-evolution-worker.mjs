import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const ollamaUrl = process.env.GARVEX_LOCAL_MODEL_URL ?? "http://127.0.0.1:11434";
const model = process.env.GARVEX_LOCAL_MODEL ?? "qwen2.5:7b";
const workerId = process.env.GARVEX_WORKER_ID ?? `local-${process.pid}`;
const maxExamples = Number(process.env.GARVEX_EVOLUTION_EXAMPLES ?? 20);

if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl });

async function bootstrap() {
  await pool.query(`
    create table if not exists garvex_evolution_runs (
      id text primary key,
      worker_id text not null,
      status text not null,
      model text not null,
      objective text,
      input_count integer not null default 0,
      output text,
      score numeric,
      created_at timestamptz not null default now(),
      completed_at timestamptz
    );
    create table if not exists garvex_evolution_memories (
      id bigserial primary key,
      kind text not null,
      title text not null,
      content text not null,
      source_run_id text references garvex_evolution_runs(id) on delete set null,
      importance numeric not null default 0.5,
      created_at timestamptz not null default now()
    );
    create index if not exists garvex_evolution_memories_kind_idx on garvex_evolution_memories(kind);
    create table if not exists garvex_evolution_experiments (
      id bigserial primary key,
      run_id text references garvex_evolution_runs(id) on delete set null,
      name text not null,
      hypothesis text not null,
      result text,
      score numeric,
      accepted boolean not null default false,
      created_at timestamptz not null default now()
    );
  `);
}

async function recentGarvexExamples() {
  const result = await pool.query(
    `select title, messages, created_at from garvex_chats order by created_at desc limit $1`,
    [maxExamples],
  );
  return result.rows.map((row) => ({ title: row.title, messages: row.messages, createdAt: row.created_at }));
}

async function askLocalModel(prompt) {
  const response = await fetch(`${ollamaUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "You are Garvex Evolution Engine. You are not the production Garvex agent. Analyze Garvex's own experiences and produce compact, actionable lessons. Never claim that a lesson is true unless the supplied evidence supports it. Do not call external AI services. Return JSON with keys: objective, lessons (array of {title,content,importance}), experiment (object with name,hypothesis,result,score).",
        },
        { role: "user", content: prompt },
      ],
      options: { temperature: 0.1 },
    }),
  });
  if (!response.ok) throw new Error(`Local Ollama request failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  return String(data?.message?.content ?? "");
}

function parseJson(text) {
  const fenced = text.match(/```(?:json)?\\s*([\\s\\S]*?)```/i);
  const source = fenced?.[1] ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch { return null; }
}

async function run() {
  await bootstrap();
  const runId = crypto.randomUUID();
  const examples = await recentGarvexExamples();
  const objective = "Improve Garvex using its own accumulated experiences without external AI providers.";
  await pool.query(
    `insert into garvex_evolution_runs (id, worker_id, status, model, objective, input_count) values ($1,$2,'RUNNING',$3,$4,$5)`,
    [runId, workerId, model, objective, examples.length],
  );

  try {
    const output = await askLocalModel(JSON.stringify({ objective, examples }));
    const parsed = parseJson(output) ?? { objective, lessons: [], experiment: { name: "unparsed-output", hypothesis: "", result: output, score: null } };
    for (const lesson of Array.isArray(parsed.lessons) ? parsed.lessons : []) {
      if (!lesson?.title || !lesson?.content) continue;
      await pool.query(
        `insert into garvex_evolution_memories (kind,title,content,source_run_id,importance) values ('LESSON',$1,$2,$3,$4)`,
        [String(lesson.title).slice(0, 300), String(lesson.content).slice(0, 10000), runId, Number(lesson.importance ?? 0.5)],
      );
    }
    const experiment = parsed.experiment ?? {};
    await pool.query(
      `insert into garvex_evolution_experiments (run_id,name,hypothesis,result,score,accepted) values ($1,$2,$3,$4,$5,false)`,
      [runId, String(experiment.name ?? "experience-analysis").slice(0, 300), String(experiment.hypothesis ?? ""), String(experiment.result ?? ""), experiment.score == null ? null : Number(experiment.score)],
    );
    await pool.query(`update garvex_evolution_runs set status='COMPLETED', output=$2, score=$3, completed_at=now() where id=$1`, [runId, output.slice(0, 30000), parsed.experiment?.score == null ? null : Number(parsed.experiment.score)]);
    console.log(JSON.stringify({ ok: true, runId, workerId, model, lessons: Array.isArray(parsed.lessons) ? parsed.lessons.length : 0 }));
  } catch (error) {
    await pool.query(`update garvex_evolution_runs set status='FAILED', output=$2, completed_at=now() where id=$1`, [runId, String(error)]).catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
