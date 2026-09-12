import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiToolCalls, deployments, projects } from "@/db/schema";
import { readLiveLogs } from "@/lib/deployment-logs";
import { createDeployment, rollbackTo } from "@/lib/deploy";
import { detectFramework } from "@/lib/framework";
import { parseCommand, runCommand } from "@/lib/runtime";
import { redact } from "@/lib/crypto";

export type AIPermission = "READ_ONLY" | "DEVELOPER" | "AUTO_FIX" | "AUTO_DEPLOY";

const RANK: Record<AIPermission, number> = {
  READ_ONLY: 0,
  DEVELOPER: 1,
  AUTO_FIX: 2,
  AUTO_DEPLOY: 3,
};

export const TOOLS: Record<string, { min: AIPermission; description: string }> = {
  list_files: { min: "READ_ONLY", description: "List files in the workspace" },
  read_file: { min: "READ_ONLY", description: "Read a workspace file" },
  search_repo: { min: "READ_ONLY", description: "Search workspace contents" },
  inspect_package: { min: "READ_ONLY", description: "Read package.json" },
  inspect_build_config: { min: "READ_ONLY", description: "Resolved build configuration" },
  get_project_status: { min: "READ_ONLY", description: "Desired vs current deployment state" },
  get_deployment: { min: "READ_ONLY", description: "Deployment metadata" },
  get_deployment_logs: { min: "READ_ONLY", description: "Redacted deployment logs" },
  apply_patch: { min: "DEVELOPER", description: "Write files inside the isolated workspace" },
  git_diff: { min: "DEVELOPER", description: "Diff of workspace changes" },
  run_install: { min: "DEVELOPER", description: "Install dependencies in the sandbox" },
  run_tests: { min: "DEVELOPER", description: "Run the project test command in the sandbox" },
  run_build: { min: "DEVELOPER", description: "Run the project build command in the sandbox" },
  create_branch: { min: "AUTO_FIX", description: "Create a fix branch on GitHub" },
  create_commit: { min: "AUTO_FIX", description: "Commit workspace changes to the fix branch" },
  create_pull_request: { min: "AUTO_FIX", description: "Open a pull request with the fix" },
  trigger_preview_deployment: { min: "AUTO_FIX", description: "Deploy the fix branch as a preview" },
  trigger_production_deployment: { min: "AUTO_DEPLOY", description: "Deploy a validated fix to production" },
  rollback_deployment: { min: "AUTO_DEPLOY", description: "Roll back to a retained deployment" },
};

/** Commands the sandbox will execute. A generic run_command tool is never exposed. */
const COMMAND_ALLOWLIST = [
  "npm ci",
  "npm install",
  "npm test",
  "npm run build",
  "npm run test",
  "npm run lint",
  "pnpm install",
  "pnpm test",
  "pnpm build",
  "yarn install",
  "yarn test",
  "yarn build",
  "bun install",
  "bun test",
  "bun run build",
];

export class ToolDenied extends Error {}

export type GatewayContext = {
  projectId: string;
  orgId: string;
  conversationId: string;
  permission: AIPermission;
  workspace?: string | null;
  deploymentId?: string | null;
  secrets?: string[];
};

/**
 * Every AI capability passes through this gateway. The agent has no Docker
 * socket, no host filesystem access outside its workspace, no database
 * credentials, and cannot address another project's resources.
 */
export class ToolGateway {
  constructor(private readonly ctx: GatewayContext) {}

  private assertPermission(tool: string) {
    const spec = TOOLS[tool];
    if (!spec) throw new ToolDenied(`Unknown tool "${tool}"`);
    if (RANK[this.ctx.permission] < RANK[spec.min]) {
      throw new ToolDenied(`Tool "${tool}" requires ${spec.min} permission`);
    }
  }

  private workspacePath(relative = "."): string {
    if (!this.ctx.workspace) throw new ToolDenied("No isolated workspace is attached");
    const full = path.resolve(this.ctx.workspace, relative);
    if (!full.startsWith(path.resolve(this.ctx.workspace))) {
      throw new ToolDenied("Path escapes the isolated workspace");
    }
    return full;
  }

  async call(tool: string, args: Record<string, unknown> = {}) {
    const started = Date.now();
    try {
      this.assertPermission(tool);
      const result = await this.dispatch(tool, args);
      await db.insert(aiToolCalls).values({
        conversationId: this.ctx.conversationId,
        projectId: this.ctx.projectId,
        tool,
        args: args as object,
        allowed: true,
        result: (typeof result === "string" ? { text: result.slice(0, 4000) } : result) as object,
        durationMs: Date.now() - started,
      });
      return { ok: true as const, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.insert(aiToolCalls).values({
        conversationId: this.ctx.conversationId,
        projectId: this.ctx.projectId,
        tool,
        args: args as object,
        allowed: false,
        denyReason: message,
        durationMs: Date.now() - started,
      });
      return { ok: false as const, error: message };
    }
  }

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case "list_files": {
        const dir = this.workspacePath(String(args.path ?? "."));
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries
          .filter((e) => e.name !== "node_modules" && !e.name.startsWith(".git"))
          .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
      }
      case "read_file": {
        const file = this.workspacePath(String(args.path ?? ""));
        const content = await fs.readFile(file, "utf8");
        if (content.length > 120_000) throw new ToolDenied("File too large to read");
        return redact(content, this.ctx.secrets ?? []);
      }
      case "search_repo": {
        const query = String(args.query ?? "");
        if (!query) throw new ToolDenied("query is required");
        const res = await runCommand(
          "grep",
          ["-rn", "--exclude-dir=node_modules", "--exclude-dir=.git", "-m", "50", query, "."],
          { cwd: this.workspacePath("."), timeoutMs: 20000 },
        );
        return redact(res.stdout.slice(0, 20000), this.ctx.secrets ?? []);
      }
      case "inspect_package": {
        const file = this.workspacePath("package.json");
        return JSON.parse(await fs.readFile(file, "utf8"));
      }
      case "inspect_build_config": {
        const [project] = await db
          .select()
          .from(projects)
          .where(eq(projects.id, this.ctx.projectId))
          .limit(1);
        const detected = this.ctx.workspace ? await detectFramework(this.workspacePath(".")) : null;
        return { configured: project, detected };
      }
      case "get_project_status": {
        const [project] = await db
          .select()
          .from(projects)
          .where(eq(projects.id, this.ctx.projectId))
          .limit(1);
        if (!project) throw new ToolDenied("Project not found");
        return {
          desiredCommitSha: project.desiredCommitSha,
          desiredDeploymentId: project.desiredDeploymentId,
          currentHealthyDeploymentId: project.currentHealthyDeploymentId,
          lastSuccessfulCommitSha: project.lastSuccessfulCommitSha,
          lastFailedCommitSha: project.lastFailedCommitSha,
          productionBranch: project.productionBranch,
          framework: project.framework,
        };
      }
      case "get_deployment": {
        const deploymentId = String(args.deploymentId ?? this.ctx.deploymentId ?? "");
        const [deployment] = await db
          .select()
          .from(deployments)
          .where(
            and(eq(deployments.id, deploymentId), eq(deployments.projectId, this.ctx.projectId)),
          )
          .limit(1);
        if (!deployment) throw new ToolDenied("Deployment not found in this project");
        return deployment;
      }
      case "get_deployment_logs": {
        const deploymentId = String(args.deploymentId ?? this.ctx.deploymentId ?? "");
        const [deployment] = await db
          .select()
          .from(deployments)
          .where(
            and(eq(deployments.id, deploymentId), eq(deployments.projectId, this.ctx.projectId)),
          )
          .limit(1);
        if (!deployment) throw new ToolDenied("Deployment not found in this project");
        const chunks = await readLiveLogs(deploymentId);
        const tail = chunks.slice(-Number(args.limit ?? 200)).map((c) => c.content).join("\n");
        return redact(tail, this.ctx.secrets ?? []);
      }
      case "apply_patch": {
        const files = (args.files ?? []) as { path: string; content: string }[];
        if (!Array.isArray(files) || files.length === 0) throw new ToolDenied("No files supplied");
        if (files.length > 20) throw new ToolDenied("Patch touches too many files");
        const written: string[] = [];
        for (const file of files) {
          if (typeof file.path !== "string" || typeof file.content !== "string") {
            throw new ToolDenied("Invalid patch entry");
          }
          if (/(^|\/)(node_modules|\.git)(\/|$)/.test(file.path)) {
            throw new ToolDenied("Patching this path is not allowed");
          }
          if (file.content.length > 200_000) throw new ToolDenied("Patch content too large");
          const target = this.workspacePath(file.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, file.content, "utf8");
          written.push(file.path);
        }
        return { written };
      }
      case "git_diff": {
        const cwd = this.workspacePath(".");
        const res = await runCommand("git", ["diff", "--stat", "-p", "--", "."], {
          cwd,
          timeoutMs: 30000,
        });
        return res.stdout.slice(0, 60000);
      }
      case "run_install":
      case "run_tests":
      case "run_build": {
        const command = String(args.command ?? defaultCommandFor(tool));
        if (!COMMAND_ALLOWLIST.includes(command.trim())) {
          throw new ToolDenied(`Command "${command}" is not on the sandbox allowlist`);
        }
        const { file, args: argv } = parseCommand(command);
        const res = await runCommand(file, argv, {
          cwd: this.workspacePath("."),
          timeoutMs: 10 * 60 * 1000,
          env: { NODE_ENV: tool === "run_install" ? "development" : "production" },
        });
        return {
          command,
          exitCode: res.code,
          timedOut: res.timedOut,
          output: redact((res.stdout + res.stderr).slice(-20000), this.ctx.secrets ?? []),
        };
      }
      case "trigger_preview_deployment": {
        const [project] = await db
          .select()
          .from(projects)
          .where(eq(projects.id, this.ctx.projectId))
          .limit(1);
        if (!project) throw new ToolDenied("Project not found");
        const deployment = await createDeployment({
          project,
          commitSha: String(args.commitSha),
          branch: String(args.branch),
          target: "PREVIEW",
          triggeredBy: "ai-agent",
          triggerSource: "ai-fix",
          aiFixOfDeploymentId: this.ctx.deploymentId ?? null,
        });
        return { deploymentId: deployment.id };
      }
      case "trigger_production_deployment": {
        const [project] = await db
          .select()
          .from(projects)
          .where(eq(projects.id, this.ctx.projectId))
          .limit(1);
        if (!project) throw new ToolDenied("Project not found");
        const deployment = await createDeployment({
          project,
          commitSha: String(args.commitSha),
          branch: project.productionBranch,
          target: "PRODUCTION",
          triggeredBy: "ai-agent",
          triggerSource: "ai-auto-deploy",
        });
        return { deploymentId: deployment.id };
      }
      case "rollback_deployment": {
        const target = await rollbackTo(
          this.ctx.projectId,
          String(args.deploymentId),
          "ai-agent",
        );
        return { deploymentId: target.id };
      }
      case "create_branch":
      case "create_commit":
      case "create_pull_request":
        throw new ToolDenied(
          "Git write operations are executed by the fix pipeline after validation",
        );
      default:
        throw new ToolDenied(`Unknown tool "${tool}"`);
    }
  }
}

function defaultCommandFor(tool: string) {
  if (tool === "run_install") return "npm ci";
  if (tool === "run_tests") return "npm test";
  return "npm run build";
}

export async function recentToolCalls(projectId: string, limit = 30) {
  return db
    .select()
    .from(aiToolCalls)
    .where(eq(aiToolCalls.projectId, projectId))
    .orderBy(desc(aiToolCalls.createdAt))
    .limit(limit);
}
