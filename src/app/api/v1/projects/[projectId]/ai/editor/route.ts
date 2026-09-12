import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiConversations, aiMessages, projects } from "@/db/schema";
import { handle, ok, readJson, requireFields } from "@/lib/api";
import { assertCsrf, HttpError, requireProjectAccess } from "@/lib/auth";
import { providerFor, resolveAIConfig, spentTodayCents, type ChatMessage, type ResolvedAIConfig } from "@/lib/ai/provider";
import { createBranchRef, createPullRequest, commitFiles, fetchCommitTarball, getBranchCommit } from "@/lib/github";
import { installationToken } from "@/lib/github-auth";
import { AI_WORKSPACE_ROOT } from "@/lib/ai/agent";
import { getPlatformSecret } from "@/lib/platform-secrets";
import { randomToken, redact } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const MAX_CONTEXT = 120_000;
const MAX_FILES = 8;

type PatchFile = { path: string; content: string };
type EditorBody = { mode: "prepare" | "apply"; prompt?: string; baseSha?: string; files?: PatchFile[]; summary?: string };

function parseJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? text;
  const start = source.indexOf("{"); const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)) as T; } catch { return null; }
}

async function walk(dir: string, root: string, out: string[] = []) {
  if (out.length >= 500) return out;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll(path.sep, "/");
    if (entry.isDirectory()) await walk(full, root, out); else out.push(rel);
    if (out.length >= 500) break;
  }
  return out;
}

async function resolveBaseSha(project: typeof projects.$inferSelect, token: string | null) {
  if (project.desiredCommitSha) return project.desiredCommitSha;
  if (project.lastSuccessfulCommitSha) return project.lastSuccessfulCommitSha;
  return (await getBranchCommit(project.repoFullName, project.productionBranch, token)).sha;
}

async function resolveEditorConfig(orgId: string): Promise<ResolvedAIConfig | null> {
  const configured = await resolveAIConfig(orgId);
  if (configured) return configured;
  const key = await getPlatformSecret("NVIDIA_API_KEY");
  if (!key) return null;
  return {
    provider: "nvidia",
    model: "deepseek-ai/deepseek-v4-flash-0731",
    apiKey: key,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    temperature: 0.1,
    maxTokens: 8192,
    dailyBudgetCents: 500,
  };
}

async function complete(orgId: string, conversationId: string, messages: ChatMessage[]) {
  const config = await resolveEditorConfig(orgId);
  if (!config) throw new AIStopped("No AI provider is configured. Add an NVIDIA API key or another BYOK provider first.");
  const spent = await spentTodayCents(orgId);
  if (config.dailyBudgetCents > 0 && spent >= config.dailyBudgetCents) throw new AIStopped("Daily AI budget exhausted");
  const result = await providerFor(config.provider).complete(messages, config);
  for (const message of messages.filter((m) => m.role !== "system")) {
    await db.insert(aiMessages).values({ conversationId, role: message.role, content: message.content.slice(0, 20000) });
  }
  await db.insert(aiMessages).values({ conversationId, role: "assistant", content: result.text.slice(0, 20000), tokensIn: result.tokensIn, tokensOut: result.tokensOut, costCents: result.costCents });
  return result;
}

class AIStopped extends Error {}

export async function POST(request: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { user, project } = await requireProjectAccess(projectId, "DEVELOPER");
    await assertCsrf(user);
    const body = await readJson<EditorBody>(request);
    requireFields(body, ["mode"]);
    const token = await installationToken(project.orgId);
    const baseSha = body.baseSha ?? await resolveBaseSha(project, token);
    const [conversation] = await db.insert(aiConversations).values({ projectId, deploymentId: project.currentHealthyDeploymentId, permission: project.aiPermission, title: body.mode === "prepare" ? "AI editor request" : "AI editor apply", createdBy: user.id }).returning();

    if (body.mode === "prepare") {
      requireFields(body, ["prompt"]);
      const workspace = path.join(AI_WORKSPACE_ROOT, `editor-${randomToken(8)}`);
      try {
        await fs.rm(workspace, { recursive: true, force: true });
        await fetchCommitTarball(project.repoFullName, baseSha, workspace, token);
        const files = await walk(workspace, workspace);
        const tree = files.join("\n");
        const first = await complete(project.orgId, conversation.id, [
          { role: "system", content: "You are the planning layer of a coding agent. Identify only the files that must be read to fulfill the user's request. Return strict JSON: {reply:string, filesToRead:string[]}. Never invent paths. Prefer the smallest set of relevant files." },
          { role: "user", content: `Project: ${project.name}\nRepository tree:\n${tree}\n\nUser request:\n${body.prompt}` },
        ]);
        const plan = parseJson<{ reply: string; filesToRead: string[] }>(first.text) ?? { reply: first.text, filesToRead: [] };
        const selected = Array.from(new Set((plan.filesToRead ?? []).filter((file) => files.includes(file)).slice(0, MAX_FILES)));
        const snippets: string[] = []; let total = 0;
        for (const file of selected) {
          const content = redact(await fs.readFile(path.join(workspace, file), "utf8"), []);
          const limited = content.slice(0, Math.min(35_000, MAX_CONTEXT - total));
          if (!limited) continue;
          snippets.push(`===== ${file} =====\n${limited}`); total += limited.length;
          if (total >= MAX_CONTEXT) break;
        }
        const second = await complete(project.orgId, conversation.id, [
          { role: "system", content: "You are the implementation layer of a coding agent. Based only on the repository tree and supplied file contents, create the smallest safe change. Return strict JSON: {reply:string, summary:string, files:[{path:string,content:string}]}. content must be the FULL replacement content for each changed file. Never modify secrets, lockfiles, CI credentials, node_modules or .git. Use only files shown in context unless adding a genuinely necessary new file." },
          { role: "user", content: `Project: ${project.name}\nBase commit: ${baseSha}\nUser request:\n${body.prompt}\n\nRepository tree:\n${tree}\n\nSelected file contents:\n${snippets.join("\n\n")}` },
        ]);
        const patch = parseJson<{ reply: string; summary: string; files: PatchFile[] }>(second.text);
        if (!patch?.files?.length) throw new HttpError(422, "The AI did not produce an applicable file change");
        const safeFiles = patch.files.slice(0, 15).filter((file) => typeof file.path === "string" && typeof file.content === "string" && !/(^|\/)(node_modules|\.git|\.env)(\/|$)/.test(file.path));
        if (!safeFiles.length) throw new HttpError(422, "The AI returned no safe files to change");
        return ok({ reply: patch.reply ?? plan.reply, summary: patch.summary ?? "AI change prepared", files: safeFiles, baseSha, provider: second.provider, model: second.model });
      } finally { await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined); }
    }

    if (project.aiPermission === "READ_ONLY") throw new HttpError(403, "AI permission is READ_ONLY");
    if (!body.files?.length) throw new HttpError(400, "files are required to apply a change");
    const safeFiles = body.files.slice(0, 15).filter((file) => typeof file.path === "string" && typeof file.content === "string" && file.path.length <= 300 && file.content.length <= 150_000 && !file.path.startsWith("/") && !file.path.includes("..") && !/(^|\/)(node_modules|\.git|\.env)(\/|$)/.test(file.path));
    if (!safeFiles.length) throw new HttpError(400, "No safe files to apply");

    const branch = `ai-edit/${baseSha.slice(0, 7)}-${randomToken(5)}`;
    if (!(await createBranchRef(project.repoFullName, token, branch, baseSha))) throw new HttpError(400, "Could not create the AI edit branch");
    const commitSha = await commitFiles(project.repoFullName, token, { branch, baseSha, message: `feat: ${body.summary?.slice(0, 110) || "AI editor change"}`, files: safeFiles });
    const pr = await createPullRequest(project.repoFullName, token, { title: `AI editor: ${body.summary?.slice(0, 90) || "Requested change"}`, head: branch, base: project.productionBranch, body: `Created from the VO in-site AI editor.\n\nBase commit: ${baseSha}\nCommit: ${commitSha}\n\nThe change was generated from the user's request and published to an isolated branch.` });
    return ok({ applied: true, branch, commitSha, pullRequest: pr?.html_url ?? null });
  });
}
