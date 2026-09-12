import fs from "node:fs/promises";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiActions, aiConversations, aiFixAttempts, aiMessages, deployments, projects } from "@/db/schema";
import { ToolGateway, type AIPermission } from "@/lib/ai/gateway";
import { providerFor, resolveAIConfig, spentTodayCents, type ChatMessage } from "@/lib/ai/provider";
import { audit, notify } from "@/lib/audit";
import { readLiveLogs } from "@/lib/deployment-logs";
import { projectEnv } from "@/lib/deploy";
import { createBranchRef, createPullRequest, commitFiles, fetchCommitTarball } from "@/lib/github";
import { installationToken } from "@/lib/github-auth";
import { log } from "@/lib/logger";
import { runCommand } from "@/lib/runtime";
import { redact } from "@/lib/crypto";

export const AI_WORKSPACE_ROOT =
  process.env.AI_WORKSPACE_ROOT ?? path.join(process.cwd(), ".platform", "ai-workspaces");

const MAX_EXECUTION_MS = Number(process.env.AI_MAX_EXECUTION_MS ?? 15 * 60 * 1000);

export class AIStopped extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function startConversation(
  projectId: string,
  deploymentId: string | null,
  permission: AIPermission,
  title: string,
  actor: string,
) {
  const [conversation] = await db
    .insert(aiConversations)
    .values({ projectId, deploymentId, permission, title, createdBy: actor })
    .returning();
  return conversation;
}

async function ask(
  orgId: string,
  conversationId: string,
  messages: ChatMessage[],
): Promise<{ text: string; costCents: number; provider: string; model: string }> {
  const config = await resolveAIConfig(orgId);
  if (!config) throw new AIStopped("No AI provider is configured (BYOK key missing)");
  const spent = await spentTodayCents(orgId);
  if (spent >= config.dailyBudgetCents) {
    throw new AIStopped(`Daily AI budget exhausted (${spent.toFixed(2)}¢)`);
  }
  const provider = providerFor(config.provider);
  const result = await provider.complete(messages, config);
  for (const message of messages.filter((m) => m.role !== "system")) {
    await db.insert(aiMessages).values({
      conversationId,
      role: message.role,
      content: message.content.slice(0, 20000),
    });
  }
  await db.insert(aiMessages).values({
    conversationId,
    role: "assistant",
    content: result.text.slice(0, 20000),
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costCents: result.costCents,
  });
  return result;
}

function parseJsonBlock<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export type Diagnosis = {
  rootCause: string;
  confidence: "low" | "medium" | "high";
  filesInvolved: string[];
  recommendedFix: string;
  riskLevel: "low" | "medium" | "high";
};

/** Reads failure context (redacted) and produces a structured diagnosis. */
export async function diagnoseDeployment(deploymentId: string, actor = "system") {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!deployment) throw new Error("Deployment not found");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, deployment.projectId))
    .limit(1);
  if (!project) throw new Error("Project not found");

  const conversation = await startConversation(
    project.id,
    deploymentId,
    project.aiPermission as AIPermission,
    `Diagnosis for ${deployment.commitSha.slice(0, 7)}`,
    actor,
  );
  const [action] = await db
    .insert(aiActions)
    .values({
      projectId: project.id,
      deploymentId,
      conversationId: conversation.id,
      kind: "DIAGNOSIS",
      status: "running",
      createdBy: actor,
    })
    .returning();

  try {
    const secrets = Object.values(await projectEnv(project.id, "PRODUCTION"));
    const chunks = await readLiveLogs(deploymentId);
    const tail = redact(chunks.slice(-250).map((c) => c.content).join("\n"), secrets);

    const system = [
      "You are a senior release engineer for a self-hosted deployment platform.",
      "Diagnose why a deployment failed using only the supplied evidence.",
      "Respond with strict JSON: {rootCause, confidence, filesInvolved, recommendedFix, riskLevel}.",
      "Never invent log output. If evidence is insufficient, say so in rootCause with low confidence.",
    ].join(" ");
    const user = [
      `Project: ${project.name} (${project.framework ?? "unknown framework"})`,
      `Branch: ${deployment.branch} Commit: ${deployment.commitSha}`,
      `Failure: ${deployment.errorReason ?? "unknown"}`,
      `Install: ${project.installCommand ?? "auto"} | Build: ${project.buildCommand ?? "auto"} | Start: ${project.startCommand ?? "auto"}`,
      "",
      "Deployment log tail:",
      tail.slice(-12000),
    ].join("\n");

    const result = await ask(project.orgId, conversation.id, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    const parsed = parseJsonBlock<Diagnosis>(result.text);
    const summary = parsed?.rootCause ?? result.text.slice(0, 500);
    await db
      .update(aiActions)
      .set({
        status: "succeeded",
        summary,
        detail: (parsed ?? { raw: result.text }) as object,
        provider: result.provider,
        model: result.model,
        costCents: result.costCents,
        finishedAt: new Date(),
      })
      .where(eq(aiActions.id, action.id));
    await notify({
      orgId: project.orgId,
      projectId: project.id,
      type: "ai.diagnosis",
      severity: "info",
      title: `AI diagnosis ready for ${project.name}`,
      body: summary.slice(0, 240),
    });
    return { actionId: action.id, diagnosis: parsed, raw: result.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(aiActions)
      .set({ status: "failed", summary: message.slice(0, 500), finishedAt: new Date() })
      .where(eq(aiActions.id, action.id));
    throw error;
  }
}

type PatchResponse = { summary: string; files: { path: string; content: string }[] };

/**
 * Bounded repair loop. All modifications happen in an isolated workspace that
 * contains only the failing commit; production is never touched directly.
 */
export async function runFixLoop(deploymentId: string, actor = "system") {
  const started = Date.now();
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!deployment) throw new Error("Deployment not found");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, deployment.projectId))
    .limit(1);
  if (!project) throw new Error("Project not found");

  const permission = project.aiPermission as AIPermission;
  if (permission === "READ_ONLY") {
    throw new AIStopped("Project AI permission is READ_ONLY; code changes are not allowed");
  }

  const conversation = await startConversation(
    project.id,
    deploymentId,
    permission,
    `Fix attempt for ${deployment.commitSha.slice(0, 7)}`,
    actor,
  );
  const [action] = await db
    .insert(aiActions)
    .values({
      projectId: project.id,
      deploymentId,
      conversationId: conversation.id,
      kind: "FIX",
      status: "running",
      createdBy: actor,
    })
    .returning();

  const secrets = Object.values(await projectEnv(project.id, "PRODUCTION"));
  const attempts: string[] = [];
  let lastError = deployment.errorReason ?? "unknown failure";
  let succeeded = false;
  let stopReason = "max attempts reached";

  for (let attempt = 1; attempt <= project.aiMaxFixAttempts; attempt++) {
    if (Date.now() - started > MAX_EXECUTION_MS) {
      stopReason = "execution timeout";
      break;
    }
    const [record] = await db
      .insert(aiFixAttempts)
      .values({ projectId: project.id, deploymentId, actionId: action.id, attempt })
      .returning();
    const workspace = path.join(AI_WORKSPACE_ROOT, record.id);

    try {
      const token = await installationToken(project.orgId);
      await fs.rm(workspace, { recursive: true, force: true });
      await fetchCommitTarball(project.repoFullName, deployment.commitSha, workspace, token);
      await db
        .update(aiFixAttempts)
        .set({ workspacePath: workspace })
        .where(eq(aiFixAttempts.id, record.id));

      // Baseline commit so that git diff shows exactly what the agent changed.
      await runCommand("git", ["init", "-q"], { cwd: workspace, timeoutMs: 20000 });
      await runCommand("git", ["config", "user.email", "ai@platform.local"], { cwd: workspace, timeoutMs: 10000 });
      await runCommand("git", ["config", "user.name", "platform-ai"], { cwd: workspace, timeoutMs: 10000 });
      await runCommand("git", ["add", "-A"], { cwd: workspace, timeoutMs: 60000 });
      await runCommand("git", ["commit", "-qm", "baseline"], { cwd: workspace, timeoutMs: 60000 });

      const gateway = new ToolGateway({
        projectId: project.id,
        orgId: project.orgId,
        conversationId: conversation.id,
        permission,
        workspace,
        deploymentId,
        secrets,
      });

      const logs = await gateway.call("get_deployment_logs", { deploymentId, limit: 200 });
      const tree = await gateway.call("list_files", { path: "." });
      const pkg = await gateway.call("inspect_package", {});

      const system = [
        "You are an autonomous repair agent working inside an isolated workspace.",
        "Produce the smallest possible change that fixes the failing build.",
        "Respond with strict JSON: {summary, files:[{path, content}]} where content is the FULL new file content.",
        "Never modify lockfiles, CI credentials, node_modules or .git. Never add secrets.",
      ].join(" ");
      const user = [
        `Attempt ${attempt} of ${project.aiMaxFixAttempts}.`,
        `Framework: ${project.framework ?? "unknown"}`,
        `Previous failure: ${lastError}`,
        `Repository tree: ${JSON.stringify(tree.result).slice(0, 3000)}`,
        `package.json: ${JSON.stringify(pkg.result).slice(0, 4000)}`,
        "Failure log tail:",
        String(logs.result ?? "").slice(-8000),
      ].join("\n");

      const answer = await ask(project.orgId, conversation.id, [
        { role: "system", content: system },
        { role: "user", content: user },
      ]);
      const patch = parseJsonBlock<PatchResponse>(answer.text);
      if (!patch?.files?.length) {
        lastError = "Model did not return an applicable patch";
        await db
          .update(aiFixAttempts)
          .set({ outcome: "no_patch", stopReason: lastError, finishedAt: new Date() })
          .where(eq(aiFixAttempts.id, record.id));
        attempts.push(`attempt ${attempt}: no patch`);
        continue;
      }

      const applied = await gateway.call("apply_patch", { files: patch.files });
      if (!applied.ok) throw new AIStopped(applied.error);

      const diff = await gateway.call("git_diff", {});
      const diffText = String(diff.result ?? "");
      if (diffText.length > 200_000) throw new AIStopped("Change set is too broad for automatic repair");

      const install = await gateway.call("run_install", { command: "npm install" });
      const installOk = (install.result as { exitCode: number } | undefined)?.exitCode === 0;
      let testsPassed: boolean | null = null;
      if (project.testCommand) {
        const tests = await gateway.call("run_tests", { command: "npm test" });
        testsPassed = (tests.result as { exitCode: number } | undefined)?.exitCode === 0;
      }
      const build = await gateway.call("run_build", { command: "npm run build" });
      const buildOk = (build.result as { exitCode: number } | undefined)?.exitCode === 0;
      const buildOutput = String((build.result as { output?: string } | undefined)?.output ?? "");

      await db
        .update(aiFixAttempts)
        .set({
          diff: diffText.slice(0, 100_000),
          filesChanged: patch.files.map((f) => f.path) as object,
          testsPassed,
          buildPassed: buildOk && installOk,
          outcome: buildOk && installOk && testsPassed !== false ? "validated" : "failed",
          finishedAt: new Date(),
        })
        .where(eq(aiFixAttempts.id, record.id));

      if (!installOk || !buildOk || testsPassed === false) {
        lastError = buildOutput.slice(-4000) || "validation failed";
        attempts.push(`attempt ${attempt}: validation failed`);
        await fs.rm(workspace, { recursive: true, force: true });
        continue;
      }

      // Validated fix: publish through GitHub, never straight to the prod branch.
      let prUrl: string | null = null;
      let fixBranch: string | null = null;
      if (token) {
        fixBranch = `ai-fix/${deployment.commitSha.slice(0, 7)}-${record.id.slice(0, 6)}`;
        await createBranchRef(project.repoFullName, token, fixBranch, deployment.commitSha);
        await commitFiles(project.repoFullName, token, {
          branch: fixBranch,
          baseSha: deployment.commitSha,
          message: `fix: ${patch.summary.slice(0, 120)}\n\nAutomated repair by the deployment platform.`,
          files: patch.files,
        });
        const pr = await createPullRequest(project.repoFullName, token, {
          title: `AI fix: ${patch.summary.slice(0, 100)}`,
          head: fixBranch,
          base: project.productionBranch,
          body: [
            `Automated repair for failed deployment \`${deployment.id}\`.`,
            "",
            `**Summary:** ${patch.summary}`,
            "",
            "Validation inside the isolated sandbox:",
            `- install: ${installOk ? "passed" : "failed"}`,
            `- tests: ${testsPassed === null ? "not configured" : testsPassed ? "passed" : "failed"}`,
            `- build: ${buildOk ? "passed" : "failed"}`,
          ].join("\n"),
        });
        prUrl = pr?.html_url ?? null;
      }

      await db
        .update(aiFixAttempts)
        .set({ branch: fixBranch, outcome: prUrl ? "pull_request" : "validated" })
        .where(eq(aiFixAttempts.id, record.id));

      succeeded = true;
      stopReason = prUrl ? "pull request opened" : "fix validated in sandbox";
      attempts.push(`attempt ${attempt}: ${stopReason}`);
      await audit({
        orgId: project.orgId,
        projectId: project.id,
        actorId: "ai-agent",
        actorType: "ai",
        action: "ai.fix_validated",
        resourceType: "deployment",
        resourceId: deploymentId,
        newState: { branch: fixBranch, prUrl, files: patch.files.map((f) => f.path) },
      });
      await notify({
        orgId: project.orgId,
        projectId: project.id,
        type: "ai.fix_succeeded",
        severity: "success",
        title: `AI fix validated for ${project.name}`,
        body: prUrl ?? patch.summary.slice(0, 200),
      });
      await fs.rm(workspace, { recursive: true, force: true });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("AI fix attempt failed", { projectId: project.id, deploymentId, error: message });
      lastError = message;
      attempts.push(`attempt ${attempt}: ${message.slice(0, 120)}`);
      await db
        .update(aiFixAttempts)
        .set({ outcome: "error", stopReason: message.slice(0, 500), finishedAt: new Date() })
        .where(eq(aiFixAttempts.id, record.id));
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AIStopped) {
        stopReason = error.reason;
        break;
      }
    }
  }

  await db
    .update(aiActions)
    .set({
      status: succeeded ? "succeeded" : "failed",
      summary: `${succeeded ? "Fix validated" : "Fix not found"}: ${stopReason}`,
      detail: { attempts } as object,
      finishedAt: new Date(),
    })
    .where(eq(aiActions.id, action.id));

  if (!succeeded) {
    await notify({
      orgId: project.orgId,
      projectId: project.id,
      type: "ai.fix_failed",
      severity: "warning",
      title: `AI could not repair ${project.name}`,
      body: stopReason,
    });
  }
  return { succeeded, stopReason, attempts, actionId: action.id };
}

export async function projectAiActivity(projectId: string) {
  const actions = await db
    .select()
    .from(aiActions)
    .where(eq(aiActions.projectId, projectId))
    .orderBy(desc(aiActions.createdAt))
    .limit(20);
  const fixes = await db
    .select()
    .from(aiFixAttempts)
    .where(eq(aiFixAttempts.projectId, projectId))
    .orderBy(desc(aiFixAttempts.createdAt))
    .limit(20);
  return { actions, fixes };
}
