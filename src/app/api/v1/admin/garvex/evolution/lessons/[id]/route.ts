import { pool } from "@/db";
import { handle, ok, readJson } from "@/lib/api";
import { assertCsrf, HttpError, requirePlatformAdmin } from "@/lib/auth";
import { embed } from "@/lib/ai/memory";

export const dynamic = "force-dynamic";

type ReviewBody = { decision?: "approve" | "reject" };

function parseEvidenceIds(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

async function ensureEvolutionSchema() {
  await pool.query(`
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
  `);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    await ensureEvolutionSchema();

    const { id } = await context.params;
    if (!id || id.length > 100) throw new HttpError(400, "Invalid lesson ID");
    const body = await readJson<ReviewBody>(request);
    if (body.decision !== "approve" && body.decision !== "reject") {
      throw new HttpError(400, "decision must be approve or reject");
    }

    const candidateResult = await pool.query(
      `select id, org_id as "orgId", project_id as "projectId",
              title, content, source_example_ids as "sourceExampleIds", status
       from garvex_evolution_lessons
       where id = $1`,
      [id],
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) throw new HttpError(404, "Lesson candidate not found");
    if (candidate.status !== "CANDIDATE") throw new HttpError(409, "This lesson has already been reviewed");

    if (body.decision === "reject") {
      const rejected = await pool.query(
        `update garvex_evolution_lessons
         set status='REJECTED', reviewed_by=$1, reviewed_at=now()
         where id=$2 and status='CANDIDATE'
         returning id`,
        [user.id, id],
      );
      if (!rejected.rows[0]) throw new HttpError(409, "This lesson has already been reviewed");
      return ok({ lessonId: id, status: "REJECTED" });
    }

    const evidenceIds = parseEvidenceIds(candidate.sourceExampleIds);
    if (evidenceIds.length === 0) throw new HttpError(409, "This candidate has no verifiable evidence");
    const evidence = await pool.query(
      `select id from self_practice_examples
       where id = any($1::text[]) and project_id = $2 and verified = true`,
      [evidenceIds, candidate.projectId],
    );
    if (evidence.rows.length !== evidenceIds.length) {
      throw new HttpError(409, "The linked self-practice evidence is missing or no longer verified");
    }

    let vector: number[] | null = null;
    try {
      vector = await embed(candidate.title + "\n\n" + candidate.content);
    } catch {
      vector = null;
    }
    if (!vector || vector.length !== 1536) {
      throw new HttpError(503, "Embedding provider is unavailable. Configure OPENROUTER_API_KEY or OPENAI_API_KEY before approving lessons.");
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const lockedResult = await client.query(
        `select id, org_id as "orgId", project_id as "projectId",
                title, content, source_example_ids as "sourceExampleIds", status
         from garvex_evolution_lessons
         where id=$1
         for update`,
        [id],
      );
      const locked = lockedResult.rows[0];
      if (!locked || locked.status !== "CANDIDATE") {
        throw new HttpError(409, "This lesson has already been reviewed");
      }
      if (locked.orgId !== candidate.orgId || locked.projectId !== candidate.projectId || locked.content !== candidate.content) {
        throw new HttpError(409, "The lesson changed while it was being reviewed");
      }

      const lockedEvidenceIds = parseEvidenceIds(locked.sourceExampleIds);
      if (lockedEvidenceIds.length !== evidenceIds.length || lockedEvidenceIds.some((value) => !evidenceIds.includes(value))) {
        throw new HttpError(409, "The lesson evidence changed while it was being reviewed");
      }
      const verifiedAgain = await client.query(
        `select id from self_practice_examples
         where id = any($1::text[]) and project_id = $2 and verified = true`,
        [lockedEvidenceIds, locked.projectId],
      );
      if (verifiedAgain.rows.length !== lockedEvidenceIds.length) {
        throw new HttpError(409, "The linked self-practice evidence is missing or no longer verified");
      }

      const updated = await client.query(
        `update garvex_evolution_lessons
         set status='APPROVED', reviewed_by=$1, reviewed_at=now(), embedding=$2::vector
         where id=$3 and status='CANDIDATE'
         returning id`,
        [user.id, "[" + vector.join(",") + "]", id],
      );
      if (!updated.rows[0]) throw new HttpError(409, "This lesson has already been reviewed");

      await client.query("commit");
      return ok({ lessonId: id, status: "APPROVED", evidenceCount: lockedEvidenceIds.length });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}
