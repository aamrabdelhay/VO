import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
async function read(rel) { return fs.readFile(path.join(root, rel), "utf8"); }
async function write(rel, content) { const file = path.join(root, rel); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, "utf8"); }
function replaceOnce(source, needle, replacement, file) { const count = source.split(needle).length - 1; if (count !== 1) throw new Error(`${file}: expected one anchor, found ${count}`); return source.replace(needle, replacement); }

let provider = await read("src/lib/ai/provider.ts");
if (!provider.includes("class OllamaProvider")) {
  const lines = [
    'class OllamaProvider implements AIProvider {',
    '  readonly name = "ollama";',
    '  async complete(messages: ChatMessage[], opts: ProviderOptions) {',
    '    const base = (opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\\/$/, "");',
    '    const headers: Record<string, string> = { "content-type": "application/json" };',
    '    if (opts.apiKey) headers.authorization = "Bearer " + opts.apiKey;',
    '    const response = await fetch(base + "/api/chat", { method: "POST", headers, body: JSON.stringify({ model: opts.model, stream: false, messages: messages.map((m) => ({ role: m.role, content: textContent(m.content) })), options: { temperature: opts.temperature, num_predict: opts.maxTokens } }) });',
    '    if (!response.ok) throw new Error("Ollama request failed (" + response.status + "): " + await response.text());',
    '    const data = (await response.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };',
    '    return { text: data.message?.content ?? "", tokensIn: data.prompt_eval_count ?? 0, tokensOut: data.eval_count ?? 0, costCents: 0, provider: this.name, model: opts.model };',
    '  }',
    '}',
    '',
  ].join("\\n");
  provider = replaceOnce(provider, "export function providerFor(name: string): AIProvider {", lines + "export function providerFor(name: string): AIProvider {", "src/lib/ai/provider.ts");
  provider = replaceOnce(provider, "  switch (name) {", "  switch (name) {\\n    case \"ollama\": return new OllamaProvider();", "src/lib/ai/provider.ts");
  provider = replaceOnce(provider, "const direct: Record<string, string> = { ", "const direct: Record<string, string> = { ollama: \"OLLAMA_API_KEY\", ", "src/lib/ai/provider.ts");
  provider = replaceOnce(provider, "function defaultModel(provider: string) { ", "function defaultModel(provider: string) { if (provider === \"ollama\") return process.env.OLLAMA_MODEL ?? \"qwen2.5-coder\"; ", "src/lib/ai/provider.ts");
  await write("src/lib/ai/provider.ts", provider);
}

let queue = await read("src/lib/queue.ts");
if (!queue.includes('| "self-practice"')) { queue = replaceOnce(queue, '  | "domain-verify";', '  | "domain-verify"\n  | "self-practice";', "src/lib/queue.ts"); await write("src/lib/queue.ts", queue); }

let worker = await read("src/lib/worker.ts");
if (!worker.includes("runSelfPracticeJob")) {
  worker = replaceOnce(worker, 'import { diagnoseDeployment, runFixLoop } from "@/lib/ai/agent";', 'import { diagnoseDeployment, runFixLoop } from "@/lib/ai/agent";\nimport { runSelfPracticeJob } from "@/lib/ai/self-practice";', "src/lib/worker.ts");
  worker = replaceOnce(worker, '  "ai-fix": async (payload) => runFixLoop(String(payload.deploymentId), String(payload.actor ?? "system")),', '  "ai-fix": async (payload) => runFixLoop(String(payload.deploymentId), String(payload.actor ?? "system")),\n  "self-practice": async (payload) => runSelfPracticeJob(payload),', "src/lib/worker.ts");
  await write("src/lib/worker.ts", worker);
}

const selfPractice = [
'import fs from "node:fs/promises";',
'import path from "node:path";',
'import { desc, eq, isNotNull, sql } from "drizzle-orm";',
'import { db } from "@/db";',
'import { aiActions, aiConversations, aiFixAttempts, aiMessages, deployments, projects } from "@/db/schema";',
'import { ToolGateway } from "@/lib/ai/gateway";',
'import { providerFor, resolveAIConfig, spentTodayCents } from "@/lib/ai/provider";',
'import { projectEnv } from "@/lib/deploy";',
'import { fetchCommitTarball } from "@/lib/github";',
'import { installationToken } from "@/lib/github-auth";',
'import { redact } from "@/lib/crypto";',
'import { AI_WORKSPACE_ROOT } from "@/lib/ai/agent";',
'',
'const DAILY_LIMIT = Math.max(0, Number(process.env.SELF_PRACTICE_DAILY_LIMIT ?? 3));',
'const MAX_CONCURRENT = Math.max(1, Number(process.env.SELF_PRACTICE_MAX_CONCURRENT ?? 1));',
'export type SelfPracticeProblem = { source: "deployment" | "ai-fix-attempt" | "synthetic"; projectId: string; orgId: string; deploymentId: string | null; commitSha: string; description: string; error: string; buildCommand: string; syntheticMutation?: "typescript-type-error" };',
'type PatchResponse = { summary?: string; files: { path: string; content: string }[] };',
'',
'function parsePatch(text: string): PatchResponse | null { const fenced = text.match(/```(?:json)?\\s*([\\s\\S]*?)```/); const candidate = fenced?.[1] ?? text; const start = candidate.indexOf("{"); const end = candidate.lastIndexOf("}"); if (start < 0 || end <= start) return null; try { return JSON.parse(candidate.slice(start, end + 1)) as PatchResponse; } catch { return null; } }',
'',
'async function counts() { const r = await db.execute<{ attempts: number; running: number; passed: number }>(sql`select count(*) filter (where created_at > now() - interval \'1 day\')::int as attempts, count(*) filter (where status = \'running\')::int as running, count(*) filter (where status = \'succeeded\' and created_at > now() - interval \'1 day\')::int as passed from ai_actions where kind = \'SELF_PRACTICE\'`); return r.rows?.[0] ?? { attempts: 0, running: 0, passed: 0 }; }',
'export async function getSelfPracticeStats() { const c = await counts(); const v = await db.execute<{ total: number }>(sql`select count(*)::int as total from self_practice_examples where verified = true`); const attempts = Number(c.attempts ?? 0); return { attemptedToday: attempts, passRateToday: attempts ? Math.round((Number(c.passed ?? 0) / attempts) * 100) : 0, verifiedExamplesTotal: Number(v.rows?.[0]?.total ?? 0), running: Number(c.running ?? 0), dailyLimit: DAILY_LIMIT, enabled: process.env.SELF_PRACTICE_ENABLED === "1", providerMode: process.env.OLLAMA_BASE_URL ? "local Ollama" : "cloud fallback" }; }',
'',
'export async function harvestProblems(source: "any" | "real" | "synthetic" = "any"): Promise<SelfPracticeProblem[]> {',
'  const out: SelfPracticeProblem[] = [];',
'  if (source !== "synthetic") {',
'    const failed = await db.select({ deployment: deployments, project: projects }).from(deployments).innerJoin(projects, eq(projects.id, deployments.projectId)).where(eq(deployments.status, "FAILED")).orderBy(desc(deployments.finishedAt), desc(deployments.queuedAt)).limit(20);',
'    for (const row of failed) if (row.deployment.commitSha) out.push({ source: "deployment", projectId: row.project.id, orgId: row.project.orgId, deploymentId: row.deployment.id, commitSha: row.deployment.commitSha, description: `Failed deployment ${row.deployment.id} for ${row.project.name}`, error: row.deployment.errorReason ?? "Deployment failed without a recorded error", buildCommand: row.project.buildCommand ?? "npm run build" });',
'    const attempts = await db.select({ attempt: aiFixAttempts, deployment: deployments, project: projects }).from(aiFixAttempts).innerJoin(deployments, eq(deployments.id, aiFixAttempts.deploymentId)).innerJoin(projects, eq(projects.id, aiFixAttempts.projectId)).where(eq(aiFixAttempts.outcome, "failed")).orderBy(desc(aiFixAttempts.createdAt)).limit(20);',
'    for (const row of attempts) if (row.deployment.commitSha) out.push({ source: "ai-fix-attempt", projectId: row.project.id, orgId: row.project.orgId, deploymentId: row.deployment.id, commitSha: row.deployment.commitSha, description: `Recorded failed AI repair attempt ${row.attempt.id} for ${row.project.name}`, error: row.deployment.errorReason ?? row.attempt.stopReason ?? "Recorded AI repair attempt failed", buildCommand: row.project.buildCommand ?? "npm run build" });',
'  }',
'  if (source !== "real" && out.length === 0) {',
'    const candidates = await db.select({ id: projects.id, orgId: projects.orgId, name: projects.name, repoFullName: projects.repoFullName, lastSuccessfulCommitSha: projects.lastSuccessfulCommitSha, buildCommand: projects.buildCommand }).from(projects).where(isNotNull(projects.lastSuccessfulCommitSha)).orderBy(desc(projects.updatedAt)).limit(1);',
'    const p = candidates[0]; if (p?.lastSuccessfulCommitSha) out.push({ source: "synthetic", projectId: p.id, orgId: p.orgId, deploymentId: null, commitSha: p.lastSuccessfulCommitSha, description: `Synthetic deterministic TypeScript failure on known-passing commit ${p.lastSuccessfulCommitSha.slice(0, 7)}`, error: "Deterministic type mutation; correct repair is to remove the mutation.", buildCommand: p.buildCommand ?? "npm run build", syntheticMutation: "typescript-type-error" });',
'  }',
'  return out;',
'}',
'',
'async function synthesizeMutation(workspace: string) { const file = path.join(workspace, "src", "lib", "ai", "agent.ts"); const original = await fs.readFile(file, "utf8"); await fs.writeFile(file, original + "\\nconst __selfPracticeMutationNever: never = 1;\\n", "utf8"); }',
'',
'async function generate(problem: SelfPracticeProblem, prompt: string, conversationId: string) {',
'  let provider = "ollama"; let model = process.env.OLLAMA_MODEL ?? "qwen2.5-coder"; let apiKey = process.env.OLLAMA_API_KEY ?? ""; let baseUrl = process.env.OLLAMA_BASE_URL ?? null; let budget = Number.POSITIVE_INFINITY;',
'  if (!process.env.OLLAMA_BASE_URL) {',
'    console.warn("Self-practice cloud fallback active: this run is not provider-independent; configure OLLAMA_BASE_URL for local generation.");',
'    const config = await resolveAIConfig(problem.orgId); if (!config || config.provider === "ollama") throw new Error("No configured cloud provider available for self-practice fallback");',
'    const spent = await spentTodayCents(problem.orgId); if (spent >= config.dailyBudgetCents) throw new Error("Self-practice daily AI budget exhausted");',
'    provider = config.provider; model = config.model; apiKey = config.apiKey; baseUrl = config.baseUrl; budget = config.dailyBudgetCents;',
'  }',
'  const result = await providerFor(provider).complete([{ role: "system", content: "Return strict JSON only: {summary:string,files:[{path:string,content:string}]}. The execution verifier is the only judge." }, { role: "user", content: prompt }], { model, apiKey, baseUrl, temperature: 0.1, maxTokens: 4096 });',
'  await db.insert(aiMessages).values({ conversationId, role: "assistant", content: result.text.slice(0, 20000), tokensIn: result.tokensIn, tokensOut: result.tokensOut, costCents: result.costCents });',
'  if (provider !== "ollama" && result.costCents > budget) throw new Error("Self-practice cloud generation exceeded daily budget");',
'  return { result, provider, model };',
'}',
'',
'export async function runSelfPracticeJob(payload: Record<string, unknown> = {}) {',
'  if (process.env.SELF_PRACTICE_ENABLED !== "1") return { skipped: true, reason: "SELF_PRACTICE_ENABLED is not 1" };',
'  const c = await counts(); if (Number(c.running ?? 0) >= MAX_CONCURRENT) return { skipped: true, reason: "concurrency cap reached" }; if (Number(c.attempts ?? 0) >= DAILY_LIMIT) return { skipped: true, reason: "daily attempt cap reached" };',
'  const source = payload.source === "synthetic" ? "synthetic" : payload.source === "real" ? "real" : "any"; const problem = (await harvestProblems(source))[0]; if (!problem) return { skipped: true, reason: "no harvested problem" };',
'  const [action] = await db.insert(aiActions).values({ projectId: problem.projectId, deploymentId: problem.deploymentId, kind: "SELF_PRACTICE", status: "running", createdBy: "system", summary: problem.description }).returning();',
'  const workspace = path.join(AI_WORKSPACE_ROOT, `self-practice-${action.id}`); const secrets = Object.values(await projectEnv(problem.projectId, "PRODUCTION"));',
'  try {',
'    const project = (await db.select().from(projects).where(eq(projects.id, problem.projectId)).limit(1))[0]; if (!project) throw new Error("Project not found");',
'    const token = await installationToken(problem.orgId); await fs.rm(workspace, { recursive: true, force: true }); await fetchCommitTarball(project.repoFullName, problem.commitSha, workspace, token);',
'    const gateway = new ToolGateway({ projectId: project.id, orgId: project.orgId, conversationId: action.id, permission: "DEVELOPER", workspace, deploymentId: problem.deploymentId, secrets });',
'    if (problem.syntheticMutation) { await synthesizeMutation(workspace); const install = await gateway.call("run_install", { command: "npm install" }); if (!install.ok) throw new Error("Synthetic install failed: " + install.error); const build = await gateway.call("run_build", { command: problem.buildCommand }); if ((build.result as { exitCode?: number } | undefined)?.exitCode === 0) throw new Error("Synthetic mutation did not fail the build"); }',
'    const [conversation] = await db.insert(aiConversations).values({ projectId: project.id, deploymentId: problem.deploymentId, permission: "DEVELOPER", title: "Self-practice repair", createdBy: "system" }).returning();',
'    const files = await gateway.call("list_files", { path: "src" });',
'    const prompt = `Repair this verified code failure. Commit: ${problem.commitSha}. Problem: ${problem.description}. Failure: ${redact(problem.error, secrets)}. Build: ${problem.buildCommand}. Source tree: ${JSON.stringify(files.result).slice(0, 6000)}. Return strict JSON with full changed file contents.`;',
'    const generated = await generate(problem, prompt, conversation.id); const patch = parsePatch(generated.result.text); if (!patch?.files.length) throw new Error("No applicable JSON patch returned");',
'    const applied = await gateway.call("apply_patch", { files: patch.files }); if (!applied.ok) throw new Error(applied.error);',
'    const install = await gateway.call("run_install", { command: "npm install" }); const tests = project.testCommand ? await gateway.call("run_tests", { command: project.testCommand }) : null; const build = await gateway.call("run_build", { command: problem.buildCommand });',
'    const installCode = (install.result as { exitCode?: number } | undefined)?.exitCode; const testCode = tests ? (tests.result as { exitCode?: number } | undefined)?.exitCode : 0; const buildCode = (build.result as { exitCode?: number } | undefined)?.exitCode;',
'    const validationOutput = redact(JSON.stringify({ install: install.result, tests: tests?.result, build: build.result }).slice(0, 20000), secrets);',
'    if (installCode !== 0 || testCode !== 0 || buildCode !== 0) throw new Error(`Execution verifier failed: install=${installCode} test=${testCode} build=${buildCode}`);',
'    const diff = await gateway.call("git_diff", {});',
'    const [example] = await db.execute(sql`insert into self_practice_examples (id, project_id, source, problem_description, diff, validation_output, verified, created_at) values (${crypto.randomUUID()}, ${project.id}, ${problem.source}, ${problem.description}, ${redact(String(diff.result ?? "").slice(0, 200000), secrets)}, ${validationOutput}, true, now()) returning id, project_id as "projectId", source, problem_description as "problemDescription", diff, validation_output as "validationOutput", verified, created_at as "createdAt"`);',
'    await db.update(aiActions).set({ status: "succeeded", provider: generated.provider, model: generated.model, costCents: generated.result.costCents, finishedAt: new Date(), summary: patch.summary ?? problem.description }).where(eq(aiActions.id, action.id));',
'    return { ok: true, example: example.rows?.[0] ?? null };',
'  } catch (error) { await db.update(aiActions).set({ status: "failed", finishedAt: new Date(), summary: redact(error instanceof Error ? error.message : String(error), secrets).slice(0, 500) }).where(eq(aiActions.id, action.id)); throw error; }',
'  finally { await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined); }',
'}',
'',
].join("\n");
await write("src/lib/ai/self-practice.ts", selfPractice);

await write("scripts/export-training-set.mjs", [
  'import fs from "node:fs"; import path from "node:path"; import pg from "pg";',
  'const output = process.argv[2] ?? path.join(process.cwd(), "self-practice-training.jsonl");',
  'if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");',
  'const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();',
  'try { const rows = await client.query("select problem_description, diff from self_practice_examples where verified = true order by created_at asc"); fs.writeFileSync(output, rows.rows.map((r) => JSON.stringify({ messages: [{ role: "system", content: "Repair the supplied software defect with the smallest safe patch." }, { role: "user", content: r.problem_description }, { role: "assistant", content: r.diff }] })).join("\\n") + (rows.rowCount ? "\\n" : "")); console.log(JSON.stringify({ output, examples: rows.rowCount })); } finally { await client.end(); }',
].join("\n"));

let page = await read("src/app/(app)/admin/garvex/page.tsx");
if (!page.includes("getSelfPracticeStats")) {
  page = replaceOnce(page, 'import { getGarvexProviderStatus } from "@/lib/ai/provider";', 'import { getGarvexProviderStatus } from "@/lib/ai/provider";\nimport { getSelfPracticeStats } from "@/lib/ai/self-practice";', "garvex page");
  page = replaceOnce(page, 'const [providers, capabilities] = await Promise.all([getGarvexProviderStatus(), getGarvexCapabilityPlans()]);', 'const [providers, capabilities, selfPractice] = await Promise.all([getGarvexProviderStatus(), getGarvexCapabilityPlans(), getSelfPracticeStats()]);', "garvex page");
  page = replaceOnce(page, '    <GarvexCapabilityPanel capabilities={capabilities} />', '    <GarvexCapabilityPanel capabilities={capabilities} />\n    <section className="garvex-self-practice-panel"><strong>Verified code-repair examples collected: {selfPractice.verifiedExamplesTotal}</strong><span>Run scripts/export-training-set.mjs and fine-tune periodically to apply them.</span><div><span>Attempts today: {selfPractice.attemptedToday}/{selfPractice.dailyLimit}</span><span>Pass rate: {selfPractice.passRateToday}%</span><span>Generation: {selfPractice.providerMode}</span></div></section>', "garvex page");
  await write("src/app/(app)/admin/garvex/page.tsx", page);
}

let css = await read("src/app/garvex-capability-panel.css").catch(() => "");
if (!css.includes("garvex-self-practice-panel")) { css += "\n.garvex-self-practice-panel{margin:24px auto;max-width:1400px;padding:18px 20px;border:1px solid rgba(16,28,44,.12);border-radius:14px;background:#fff;display:flex;flex-direction:column;gap:10px}.garvex-self-practice-panel>div{display:flex;gap:20px;flex-wrap:wrap}.garvex-self-practice-panel span{color:#6b6b6b}\n"; await write("src/app/garvex-capability-panel.css", css); }

let ops = await read("docs/OPERATIONS.md");
if (!ops.includes("## Self-practice verified code-repair loop")) { ops += "\n\n## Self-practice verified code-repair loop\n\nSelf-practice collects real failed deployments and recorded failed AI repair attempts, plus deterministic synthetic compiler mutations. Correctness is judged only by sandbox execution exit codes; there is no LLM-as-judge step and model output is never used as ground truth.\n\nEnable with `SELF_PRACTICE_ENABLED=1`, `SELF_PRACTICE_DAILY_LIMIT`, and `SELF_PRACTICE_MAX_CONCURRENT`. With `OLLAMA_BASE_URL`, generation is local Ollama. Without it, the explicit cloud fallback is used and its recorded generation cost is included in the existing AI message spend budget.\n\nThis does not automatically train a model. Run `node scripts/export-training-set.mjs`, upload the verified JSONL to the operator-controlled GPU/Colab environment, run manual Unsloth/LoRA fine-tuning, and push the resulting model to Ollama. Do not run unattended fine-tuning in the Vercel-hosted app.\n"; await write("docs/OPERATIONS.md", ops); }

let env = await read(".env.example"); if (!env.includes("SELF_PRACTICE_DAILY_LIMIT")) { env += "\nSELF_PRACTICE_ENABLED=0\nSELF_PRACTICE_DAILY_LIMIT=3\nSELF_PRACTICE_MAX_CONCURRENT=1\nOLLAMA_BASE_URL=http://127.0.0.1:11434\nOLLAMA_MODEL=qwen2.5-coder\n"; await write(".env.example", env); }

await write("src/app/api/v1/admin/garvex/self-practice/route.ts", [
  'import { NextResponse } from "next/server";',
  'import { requirePlatformAdmin } from "@/lib/auth";',
  'import { enqueue } from "@/lib/queue";',
  'import { getSelfPracticeStats } from "@/lib/ai/self-practice";',
  'export const dynamic = "force-dynamic";',
  'export async function GET() { await requirePlatformAdmin(); return NextResponse.json(await getSelfPracticeStats()); }',
  'export async function POST(request: Request) { await requirePlatformAdmin(); const body = (await request.json().catch(() => ({}))) as { source?: "any" | "real" | "synthetic" }; const source = body.source === "real" || body.source === "synthetic" ? body.source : "any"; const job = await enqueue({ type: "self-practice", payload: { source }, maxAttempts: 1, priority: 110 }); return NextResponse.json({ queued: Boolean(job), jobId: job?.id ?? null, source }); }',
].join("\n"));

let prepare = await read("scripts/prepare-vercel-db.mjs");
if (!prepare.includes("CREATE TABLE IF NOT EXISTS self_practice_examples")) {
  const anchor = "  await client.query(`CREATE INDEX IF NOT EXISTS container_project_idx ON container_instances(project_id, status)`);";
  prepare = replaceOnce(prepare, anchor, anchor + "\n  await client.query(`CREATE TABLE IF NOT EXISTS self_practice_examples (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source text NOT NULL, problem_description text NOT NULL, diff text NOT NULL, validation_output text NOT NULL, verified boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())`);\n  await client.query(`CREATE INDEX IF NOT EXISTS self_practice_project_idx ON self_practice_examples(project_id, created_at)`);\n  await client.query(`CREATE INDEX IF NOT EXISTS self_practice_verified_idx ON self_practice_examples(verified, created_at)` , preparePath);
  await write(preparePath, prepare);
}

let gateway = await read("src/lib/ai/gateway.ts");
if (!gateway.includes("@/lib/ai/workspace-path")) gateway = replaceOnce(gateway, 'import { redact } from "@/lib/crypto";', 'import { redact } from "@/lib/crypto";\nimport { resolveWorkspacePath } from "@/lib/ai/workspace-path";', "src/lib/ai/gateway.ts");
const unsafe = '    const full = path.resolve(this.ctx.workspace, relative);\n    if (!full.startsWith(path.resolve(this.ctx.workspace))) {\n      throw new ToolDenied("Path escapes the isolated workspace");\n    }\n    return full;';
if (gateway.includes(unsafe)) gateway = replaceOnce(gateway, unsafe, '    try { return resolveWorkspacePath(this.ctx.workspace, relative); } catch { throw new ToolDenied("Path escapes the isolated workspace"); }', "src/lib/ai/gateway.ts");
await write("src/lib/ai/gateway.ts", gateway);

console.log("self-practice implementation complete");
