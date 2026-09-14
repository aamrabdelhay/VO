import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { deployments, projects } from "@/db/schema";
import { harvestProblems, runSelfPracticeJob } from "@/lib/ai/self-practice";

async function latestExample(source: string, since: Date) {
  const result = await db.execute(sql`
    select id, project_id as "projectId", source, problem_description as "problemDescription",
           diff, validation_output as "validationOutput", verified, created_at as "createdAt"
    from self_practice_examples
    where source = ${source} and verified = true and created_at >= ${since}
    order by created_at desc
    limit 1
  `);
  return result.rows?.[0] ?? null;
}

async function main() {
  if (process.env.SELF_PRACTICE_ENABLED !== "1") throw new Error("SELF_PRACTICE_ENABLED must be 1 for E2E");
  if (!process.env.OLLAMA_BASE_URL) throw new Error("OLLAMA_BASE_URL must point to a local Ollama instance for E2E");

  const [real] = await harvestProblems("real");
  if (!real) throw new Error("No real harvested failure exists in deployments/aiFixAttempts");

  const [synthetic] = await harvestProblems("synthetic");
  if (!synthetic) throw new Error("No known-passing commit exists for synthetic mutation E2E");

  const results: Array<{ source: string; problem: typeof real; result: unknown; row: unknown }> = [];
  for (const source of ["real", "synthetic"] as const) {
    const started = new Date();
    const problem = source === "real" ? real : synthetic;
    const result = await runSelfPracticeJob({ source });
    const row = await latestExample(source, started);
    console.log(`SELF_PRACTICE_E2E ${source}:`);
    console.log(JSON.stringify({ problem, result, row }, null, 2));
    if (!row || row.verified !== true) throw new Error(`${source} did not produce a verified self_practice_examples row`);
    results.push({ source, problem, result, row });
  }

  const stored = await db.execute(sql`select count(*)::int as count from self_practice_examples where verified = true`);
  console.log(`Verified rows total: ${Number(stored.rows?.[0]?.count ?? 0)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
