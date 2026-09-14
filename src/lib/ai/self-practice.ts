import fs from "node:fs/promises";
import path from "node:path";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiActions, aiConversations, aiFixAttempts, aiMessages, deployments, projects } from "@/db/schema";
import { ToolGateway } from "@/lib/ai/gateway";
import { providerFor, resolveAIConfig, spentTodayCents, type ChatMessage } from "@/lib/ai/provider";
import { projectEnv } from "@/lib/deploy";
import { fetchCommitTarball } from "@/lib/github";
import { installationToken } from "@/lib/github-auth";
import { redact } from "@/lib/crypto";
import { runCommand } from "@/lib/runtime";
import { AI_WORKSPACE_ROOT } from "@/lib/ai/agent";

const DAILY_LIMIT = Math.max(0, Number(process.env.SELF_PRACTICE_DAILY_LIMIT ?? 3));
const MAX_CONCURRENT = Math.max(1, Number(process.env.SELF_PRACTICE_MAX_CONCURRENT ?? 1));
const MAX_OUTPUT = 20_000;

type Problem = {
  source: "deployment" | "ai-fix-attempt" | "synthetic";
  projectId: string;
  orgId: string;
  deploymentId: string | null;
  commitSha: string;
  description: string;
  error: string;
  buildCommand: string;
  synthetic?: boolean;
};
type PatchResponse = { summary?: string; files: { path: string; content: string }[] };

async function ensureTable() {
  await db.execute(sql`
    create table if not exists self_practice_examples (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      source text not null,
      problem_description text not null,
      diff text not null,
      validation_output text not null,
      verified boolean not null default false,
      created_at timestamptz not null default now()
    )
  `);
  await db.execute(sql`create index if not exists self_practice_verified_idx on self_practice_examples(verified, created_at)`);
}

async function statsRaw() {
  const result = await db.execute<{ attempts: number; running: number; passed: number }>(sql`
    select count(*) filter (where created_at > now() - interval '1 day')::int as attempts,
           count(*) filter (where status = 'running')::int as running,
           count(*) filter (where status = 'succeeded' and created_at > now() - interval '1 day')::int as passed
    from ai_actions where kind = 'SELF_PRACTICE'
  `);
  return result.rows?.[0] ?? { attempts: 0, running: 0, passed: 0 };
}

export async function getSelfPracticeStats() {
  await ensureTable();
  const [stats, verified] = await Promise.all([
    statsRaw(),
    db.execute<{ total: number }>(sql`select count(*)::int as total from self_practice_examples where verified = true`),
  ]);
  const attempts = Number(stats.attempts ?? 0);
  return {
    attemptedToday: attempts,
    passRateToday: attempts ? Math.round((Number(stats.passed ?? 0) / attempts) * 100) : 0,
    verifiedExamplesTotal: Number(verified.rows?.[0]?.total ?? 0),
    running: Number(stats.running ?? 0),
    dailyLimit: DAILY_LIMIT,
    enabled: process.env.SELF_PRACTICE_ENABLED === "1",
    providerMode: process.env.OLLAMA_BASE_URL ? "local Ollama" : "cloud fallback",
  };
}

export async function harvestProblems(source: "any" | "real" | "synthetic" = "any"): Promise<Problem[]> {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  if (source !== "synthetic") {
    const failed = await db.select({ deployment: deployments, project: projects }).from(deployments).innerJoin(projects, eq(projects.id, deployments.projectId)).where(eq(deployments.status, "FAILED")).orderBy(desc(deployments.finishedAt), desc(deployments.queuedAt)).limit(20);
    for (const row of failed) {
      if (!row.deployment.commitSha || seen.has(row.deployment.id)) continue;
      seen.add(row.deployment.id);
      problems.push({ source: "deployment", projectId: row.project.id, orgId: row.project.orgId, deploymentId: row.deployment.id, commitSha: row.deployment.commitSha, description: `Failed deployment ${row.deployment.id} for ${row.project.name}`, error: row.deployment.errorReason ?? "Deployment failed without recorded error", buildCommand: row.project.buildCommand ?? "npm run build" });
    }
    const attempts = await db.select({ attempt: aiFixAttempts, deployment: deployments, project: projects }).from(aiFixAttempts).innerJoin(deployments, eq(deployments.id, aiFixAttempts.deploymentId)).innerJoin(projects, eq(projects.id, aiFixAttempts.projectId)).where(eq(aiFixAttempts.outcome, "failed")).orderBy(desc(aiFixAttempts.createdAt)).limit(20);
    for (const row of attempts) {
      if (!row.deployment.commitSha || seen.has(row.attempt.id)) continue;
      seen.add(row.attempt.id);
      problems.push({ source: "ai-fix-attempt", projectId: row.project.id, orgId: row.project.orgId, deploymentId: row.deployment.id, commitSha: row.deployment.commitSha, description: `Recorded failed AI repair attempt ${row.attempt.id} for ${row.project.name}`, error: row.deployment.errorReason ?? row.attempt.stopReason ?? "Recorded AI repair attempt failed", buildCommand: row.project.buildCommand ?? "npm run build" });
    }
  }
  if (source !== "real" && problems.length === 0) {
    const candidates = await db.select({ id: projects.id, orgId: projects.orgId, name: projects.name, lastSuccessfulCommitSha: projects.lastSuccessfulCommitSha, buildCommand: projects.buildCommand }).from(projects).where(isNotNull(projects.lastSuccessfulCommitSha)).orderBy(desc(projects.updatedAt)).limit(1);
    const project = candidates[0];
    if (project?.lastSuccessfulCommitSha) problems.push({ source: "synthetic", projectId: project.id, orgId: project.orgId, deploymentId: null, commitSha: project.lastSuccessfulCommitSha, description: `Synthetic deterministic TypeScript failure on known-passing commit ${project.lastSuccessfulCommitSha.slice(0, 7)}`, error: "Deterministic mutation: const __selfPracticeMutationNever: never = 1", buildCommand: project.buildCommand ?? "npm run build", synthetic: true });
  }
  return problems;
}

function parsePatch(text: string): PatchResponse | null {
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { const parsed = JSON.parse(candidate.slice(start, end + 1)) as PatchResponse; return Array.isArray(parsed.files) && parsed.files.length > 0 ? parsed : null; } catch { return null; }
}

async function materializeCommit(problem: Problem, project: typeof projects.$inferSelect, workspace: string) {
  await fs.rm(workspace, { recursive: true, force: true });
  await fetchCommitTarball(project.repoFullName, problem.commitSha, workspace, await installationToken(project.orgId));
  for (const args of [["init", "-q"], ["config", "user.email", "ai@platform.local"], ["config", "user.name", "platform-ai"], ["add", "-A"]]) {
    const result = await runCommand("git", args, { cwd: workspace, timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(`Sandbox git setup failed: ${result.stderr}`);
  }
  const baseline = await runCommand("git", ["commit", "-qm", "baseline"], { cwd: workspace, timeoutMs: 60_000 });
  if (baseline.code !== 0) throw new Error(`Sandbox baseline commit failed: ${baseline.stderr}`);
}

async function generationConfig(problem: Problem) {
  if (process.env.OLLAMA_BASE_URL) return { provider: "ollama", model: process.env.OLLAMA_MODEL ?? "qwen2.5-coder", apiKey: process.env.OLLAMA_API_KEY ?? "", baseUrl: process.env.OLLAMA_BASE_URL, dailyBudgetCents: Number.POSITIVE_INFINITY };
  console.warn("Self-practice cloud fallback active: this run is not provider-independent. Configure OLLAMA_BASE_URL for local generation.");
  const config = await resolveAIConfig(problem.orgId);
  if (!config || config.provider === "ollama") throw new Error("No configured cloud provider is available for self-practice fallback");
  const spent = await spentTodayCents(problem.orgId);
  if (spent >= config.dailyBudgetCents) throw new Error("Existing per-org daily AI budget is exhausted");
  return config;
}

async function generateRepair(problem: Problem, conversationId: string, context: string, secrets: string[]) {
  const config = await generationConfig(problem);
  const messages: ChatMessage[] = [
    { role: "system", content: "Repair code in an isolated workspace. Return strict JSON only: {summary:string,files:[{path:string,content:string}]}. Full content for changed files only. Never modify node_modules, .git, lockfiles, CI credentials, or unrelated files. The only correctness judge is execution exit codes; do not judge your own answer." },
    { role: "user", content: redact(context, secrets) },
  ];
  const result = await providerFor(config.provider).complete(messages, { model: config.model, apiKey: config.apiKey, baseUrl: config.baseUrl, temperature: 0.1, maxTokens: 4096 });
  await db.insert(aiMessages).values({ conversationId, role: "assistant", content: redact(result.text.slice(0, MAX_OUTPUT), secrets), tokensIn: result.tokensIn, tokensOut: result.tokensOut, costCents: result.costCents });
  if (config.provider !== "ollama" && (await spentTodayCents(problem.orgId)) > config.dailyBudgetCents) throw new Error("Cloud self-practice generation exceeded the existing per-org daily AI budget");
  return result;
}

export async function runSelfPracticeJob(payload: Record<string, unknown> = {}) {
  if (process.env.SELF_PRACTICE_ENABLED !== "1") return { skipped: true, reason: "SELF_PRACTICE_ENABLED is not 1" };
  await ensureTable();
  const stats = await statsRaw();
  if (Number(stats.running ?? 0) >= MAX_CONCURRENT) return { skipped: true, reason: "self-practice concurrency limit reached" };
  if (Number(stats.attempts ?? 0) >= DAILY_LIMIT) return { skipped: true, reason: "self-practice daily limit reached" };
  const source = payload.source === "real" || payload.source === "synthetic" ? payload.source : "any";
  const problem = (await harvestProblems(source))[0];
  if (!problem) return { skipped: true, reason: "no real or synthetic problem harvested" };
  const [action] = await db.insert(aiActions).values({ projectId: problem.projectId, deploymentId: problem.deploymentId, kind: "SELF_PRACTICE", status: "running", createdBy: "system", summary: problem.description }).returning();
  const workspace = path.join(AI_WORKSPACE_ROOT, `self-practice-${action.id}`);
  const secrets = Object.values(await projectEnv(problem.projectId, "PRODUCTION"));
  try {
    const [project] = await db.select().from(projects).where(eq(projects.id, problem.projectId)).limit(1); if (!project) throw new Error("Project not found");
    await materializeCommit(problem, project, workspace);
    const gateway = new ToolGateway({ projectId: project.id, orgId: project.orgId, conversationId: action.id, permission: "DEVELOPER", workspace, deploymentId: problem.deploymentId, secrets });
    let syntheticFailure = "";
    if (problem.synthetic) {
      const target = path.join(workspace, "src/lib/ai/agent.ts");
      const original = await fs.readFile(target, "utf8");
      await fs.writeFile(target, `${original}\nconst __selfPracticeMutationNever: never = 1;\n`, "utf8");
      const install = await gateway.call("run_install", { command: "npm ci" }); if (!install.ok) throw new Error(install.error);
      const build = await gateway.call("run_build", { command: project.buildCommand ?? "npm run build" });
      const exitCode = (build.result as { exitCode?: number } | undefined)?.exitCode; syntheticFailure = String((build.result as { output?: string } | undefined)?.output ?? "");
      if (exitCode === 0) throw new Error("Synthetic mutation did not make the known-passing commit fail");
    }
    const [conversation] = await db.insert(aiConversations).values({ projectId: project.id, deploymentId: problem.deploymentId, permission: "DEVELOPER", title: "Self-practice repair", createdBy: "system" }).returning();
    const tree = await gateway.call("list_files", { path: "." });
    const context = [`Source: ${problem.source}`, `Commit: ${problem.commitSha}`, `Problem: ${problem.description}`, `Reported failure: ${problem.error}`, `Build command: ${project.buildCommand ?? "npm run build"}`, `Synthetic failure output: ${syntheticFailure.slice(-8000)}`, `Workspace tree: ${JSON.stringify(tree.result).slice(0, 6000)}`, "Return the smallest safe repair as strict JSON."].join("\n");
    const generated = await generateRepair(problem, conversation.id, context, secrets);
    const patch = parsePatch(generated.text); if (!patch) throw new Error("Attempt generation did not return a valid JSON patch");
    const applied = await gateway.call("apply_patch", { files: patch.files }); if (!applied.ok) throw new Error(applied.error);
    const install = await gateway.call("run_install", { command: "npm ci" });
    const tests = project.testCommand ? await gateway.call("run_tests", { command: project.testCommand }) : null;
    const build = await gateway.call("run_build", { command: project.buildCommand ?? "npm run build" });
    const installCode = (install.result as { exitCode?: number } | undefined)?.exitCode;
    const testCode = tests ? (tests.result as { exitCode?: number } | undefined)?.exitCode : 0;
    const buildCode = (build.result as { exitCode?: number } | undefined)?.exitCode;
    const validationOutput = redact(JSON.stringify({ install: install.result, tests: tests?.result, build: build.result }).slice(0, MAX_OUTPUT), secrets);
    if (installCode !== 0 || testCode !== 0 || buildCode !== 0) {
      await db.update(aiActions).set({ status: "failed", finishedAt: new Date(), summary: `Execution verifier failed: install=${installCode} test=${testCode} build=${buildCode}` }).where(eq(aiActions.id, action.id));
      return { ok: false, verified: false, reason: "execution verifier failed", exitCodes: { install: installCode, test: testCode, build: buildCode } };
    }
    const diff = await gateway.call("git_diff", {});
    const diffText = redact(String(diff.result ?? "").slice(0, 200_000), secrets);
    const inserted = await db.execute(sql`insert into self_practice_examples (id, project_id, source, problem_description, diff, validation_output, verified, created_at) values (${crypto.randomUUID()}, ${project.id}, ${problem.source}, ${redact(problem.description, secrets)}, ${diffText}, ${validationOutput}, true, now()) returning id, project_id as "projectId", source, problem_description as "problemDescription", diff, validation_output as "validationOutput", verified, created_at as "createdAt"`);
    await db.update(aiActions).set({ status: "succeeded", provider: generated.provider, model: generated.model, costCents: generated.costCents, finishedAt: new Date(), summary: redact(patch.summary ?? problem.description, secrets) }).where(eq(aiActions.id, action.id));
    return { ok: true, verified: true, example: inserted.rows?.[0] ?? null };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), secrets);
    await db.update(aiActions).set({ status: "failed", finishedAt: new Date(), summary: message.slice(0, 500) }).where(eq(aiActions.id, action.id));
    throw new Error(message);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
