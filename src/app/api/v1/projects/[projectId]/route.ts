import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projectConfigVersions, projects } from "@/db/schema";
import { handle, ok, readJson } from "@/lib/api";
import { assertCsrf, requireProjectAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { decryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const EDITABLE = [
  "name",
  "productionBranch",
  "rootDirectory",
  "packageManager",
  "installCommand",
  "buildCommand",
  "startCommand",
  "testCommand",
  "outputDirectory",
  "nodeVersion",
  "healthPath",
  "healthExpectedStatus",
  "healthTimeoutMs",
  "healthRetries",
  "postPromotionWindowMs",
  "autoRollback",
  "previewsEnabled",
  "enabled",
  "memoryLimitMb",
  "cpuLimit",
  "retainProductionDeployments",
  "previewRetentionDays",
  "cacheRetentionDays",
  "logRetentionDays",
  "aiPermission",
  "aiAutoDiagnose",
  "aiMaxFixAttempts",
] as const;

export async function GET(_: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { project, role } = await requireProjectAccess(projectId);
    const webhookSecret = project.webhookSecretCipher
      ? decryptSecret(project.webhookSecretCipher)
      : null;
    return ok({
      project: { ...project, webhookSecretCipher: undefined },
      role,
      webhookSecretPreview: webhookSecret ? `${webhookSecret.slice(0, 4)}••••` : null,
    });
  });
}

export async function PATCH(request: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { user, project } = await requireProjectAccess(projectId, "DEVELOPER");
    await assertCsrf(user);
    const body = await readJson<Record<string, unknown>>(request);
    const patch: Record<string, unknown> = {};
    for (const key of EDITABLE) {
      if (key in body) patch[key] = body[key] === "" ? null : body[key];
    }
    if (Object.keys(patch).length === 0) return ok({ project });

    patch.configVersion = project.configVersion + 1;
    patch.updatedAt = new Date();
    const [updated] = await db
      .update(projects)
      .set(patch)
      .where(eq(projects.id, projectId))
      .returning();

    await db.insert(projectConfigVersions).values({
      projectId,
      version: updated.configVersion,
      config: patch as object,
      changedBy: user.id,
      reason: "dashboard update",
    });
    await audit({
      orgId: project.orgId,
      projectId,
      actorId: user.id,
      action: "project.updated",
      resourceType: "project",
      resourceId: projectId,
      oldState: Object.fromEntries(
        Object.keys(patch).map((k) => [k, (project as Record<string, unknown>)[k]]),
      ),
      newState: patch,
    });
    return ok({ project: { ...updated, webhookSecretCipher: undefined } });
  });
}

export async function DELETE(_: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { user, project } = await requireProjectAccess(projectId, "ADMIN");
    await assertCsrf(user);
    const { stopRuntime } = await import("@/lib/deploy");
    const { db: database } = await import("@/db");
    const { deployments } = await import("@/db/schema");
    const all = await database
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.projectId, projectId));
    for (const d of all) await stopRuntime(d.id).catch(() => undefined);
    await db.delete(projects).where(eq(projects.id, projectId));
    await audit({
      orgId: project.orgId,
      projectId,
      actorId: user.id,
      action: "project.deleted",
      resourceType: "project",
      resourceId: projectId,
      oldState: { name: project.name },
    });
    return ok({ deleted: true });
  });
}
