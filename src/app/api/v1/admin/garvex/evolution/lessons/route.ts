import { pool } from "@/db";
import { handle, ok } from "@/lib/api";
import { requirePlatformAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function ensureEvolutionSchema() {
  await pool.query(\`
    create table if not exists self_practice_examples (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      source text not null,
      problem_description text not null,
      diff text not null,
      validation_output text not null,
      verified boolean not null default false,
      created_at timestamptz not null default now()
    );

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

    create table if not exists garvex_evolution_lessons (
      id text primary key,
      run_id text references garvex_evolution_runs(id) on delete set null,
      org_id text not null references organizations(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      title text not null,
      content text not null,
      source_example_ids jsonb not null,
      embedding vector(1536),
      importance double precision not null default 0.5,
      status text not null default 'CANDIDATE',
      reviewed_by text references users(id) on delete set null,
      reviewed_at timestamptz,
      last_used_at timestamptz,
      use_count integer not null default 0,
      created_at timestamptz not null default now(),
      constraint garvex_evolution_lessons_status_check
        check (status in ('CANDIDATE', 'APPROVED', 'REJECTED')),
      constraint garvex_evolution_lessons_evidence_check
        check (jsonb_typeof(source_example_ids) = 'array' and jsonb_array_length(source_example_ids) > 0),
      constraint garvex_evolution_lessons_importance_check
        check (importance >= 0 and importance <= 1)
    );

    create index if not exists garvex_evolution_lessons_review_idx
      on garvex_evolution_lessons(status, created_at desc);
    create index if not exists garvex_evolution_lessons_scope_idx
      on garvex_evolution_lessons(org_id, project_id, status);
  \`);
}

export async function GET() {
  return handle(async () => {
    await requirePlatformAdmin();
    await ensureEvolutionSchema();

    const [rows, counts] = await Promise.all([
      pool.query(
        \`select l.id, l.title, l.content, l.importance,
                l.source_example_ids as "sourceExampleIds",
                l.created_at as "createdAt",
                p.id as "projectId", p.name as "projectName",
                coalesce((
                  select jsonb_agg(jsonb_build_object(
                    'id', e.id,
                    'source', e.source,
                    'problemDescription', e.problem_description,
                    'validationOutput', left(e.validation_output, 1600),
                    'createdAt', e.created_at
                  ) order by e.created_at desc)
                  from jsonb_array_elements_text(l.source_example_ids) as evidence_id(id)
                  inner join self_practice_examples e
                    on e.id = evidence_id.id
                   and e.project_id = l.project_id
                   and e.verified = true
                ), '[]'::jsonb) as evidence
         from garvex_evolution_lessons l
         inner join projects p on p.id = l.project_id
         where l.status = 'CANDIDATE'
         order by l.created_at desc
         limit 50\`,
      ),
      pool.query(
        \`select
           count(*) filter (where status='CANDIDATE')::int as candidates,
           count(*) filter (where status='APPROVED')::int as approved,
           count(*) filter (where status='REJECTED')::int as rejected
         from garvex_evolution_lessons\`,
      ),
    ]);

    return ok({
      lessons: rows.rows,
      counts: counts.rows[0] ?? { candidates: 0, approved: 0, rejected: 0 },
    });
  });
}
