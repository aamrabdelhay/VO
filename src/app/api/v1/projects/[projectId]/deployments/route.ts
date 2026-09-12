import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments } from "@/db/schema";
import { handle, ok, readJson } from "@/lib/api";
import { assertCsrf, HttpError, requireProjectAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { createDeployment } from "@/lib/deploy";
import { getBranchCommit } from "@/lib/github";
import { installationToken } from "@/lib/github-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    await requireProjectAccess(projectId);
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 30), 100);
    const rows = await db
      .select()
      .from(deployments)
      .where(eq(deployments.projectId, projectId))
      .orderBy(desc(deployments.queuedAt))
      .limit(limit);
    return ok({ deployments: rows });
  });
}

type Body = { branch?: string; commitSha?: string; target?: "PRODUCTION" | "PREVIEW" };

export async function POST(request: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { user, project } = await requireProjectAccess(projectId, "DEVELOPER");
    await assertCsrf(user);
    const body = await readJson<Body>(request).catch(() => ({}) as Body);
    const branch = body.branch || project.productionBranch;
    const target = body.target ?? "PRODUCTION";

    const token = await installationToken(project.orgId);
    let commit = body.commitSha
      ? { sha: body.commitSha, message: "manual deployment", author: user.name, date: new Date().toISOString() }
      : null;
    if (!commit) {
      commit = await getBranchCommit(project.repoFullName, branch, token);
    }
    if (!commit?.sha) throw new HttpError(400, "Could not resolve a commit to deploy");

    const deployment = await createDeployment({
      project,
      commitSha: commit.sha,
      branch,
      target,
      commitMessage: commit.message,
      commitAuthor: commit.author,
      commitTimestamp: new Date(commit.date),
      triggeredBy: user.email,
      triggerSource: "dashboard",
    });
    await audit({
      orgId: project.orgId,
      projectId,
      actorId: user.id,
      action: "deployment.created",
      resourceType: "deployment",
      resourceId: deployment.id,
      newState: { commitSha: commit.sha, branch, target },
    });
    return ok({ deployment });
  });
}
