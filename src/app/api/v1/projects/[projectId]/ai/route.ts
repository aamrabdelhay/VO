import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiConfigs, deployments } from "@/db/schema";
import { handle, ok, readJson } from "@/lib/api";
import { assertCsrf, HttpError, requireProjectAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { projectAiActivity } from "@/lib/ai/agent";
import { recentToolCalls, TOOLS } from "@/lib/ai/gateway";
import { resolveAIConfig, spentTodayCents } from "@/lib/ai/provider";
import { encryptSecret } from "@/lib/crypto";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function GET(_: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { project } = await requireProjectAccess(projectId);
    const activity = await projectAiActivity(projectId);
    const toolCalls = await recentToolCalls(projectId);
    const config = await resolveAIConfig(project.orgId);
    const spent = await spentTodayCents(project.orgId);
    return ok({
      permission: project.aiPermission,
      configured: Boolean(config),
      provider: config?.provider ?? null,
      model: config?.model ?? null,
      budget: { spentTodayCents: spent, dailyBudgetCents: config?.dailyBudgetCents ?? 0 },
      tools: Object.entries(TOOLS).map(([name, spec]) => ({ name, ...spec })),
      ...activity,
      toolCalls,
    });
  });
}

type Body = {
  action: "diagnose" | "fix" | "configure";
  deploymentId?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dailyBudgetCents?: number;
};

export async function POST(request: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { user, project } = await requireProjectAccess(projectId, "DEVELOPER");
    await assertCsrf(user);
    const body = await readJson<Body>(request);

    if (body.action === "configure") {
      const values = {
        orgId: project.orgId,
        provider: body.provider ?? "anthropic",
        model: body.model ?? "claude-sonnet-4-5",
        baseUrl: body.baseUrl ?? null,
        dailyBudgetCents: body.dailyBudgetCents ?? 500,
        ...(body.apiKey ? { apiKeyCipher: encryptSecret(body.apiKey) as unknown as object } : {}),
        updatedAt: new Date(),
      };
      await db
        .insert(aiConfigs)
        .values(values)
        .onConflictDoUpdate({ target: aiConfigs.orgId, set: values });
      await audit({
        orgId: project.orgId,
        projectId,
        actorId: user.id,
        action: "ai.configured",
        resourceType: "ai_config",
        newState: { provider: values.provider, model: values.model },
      });
      return ok({ configured: true });
    }

    const deploymentId =
      body.deploymentId ??
      (
        await db
          .select({ id: deployments.id })
          .from(deployments)
          .where(eq(deployments.projectId, projectId))
          .orderBy(desc(deployments.queuedAt))
          .limit(1)
      )[0]?.id;
    if (!deploymentId) throw new HttpError(400, "No deployment to analyse");

    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);
    if (!deployment || deployment.projectId !== projectId) {
      throw new HttpError(404, "Deployment not found in this project");
    }

    if (body.action === "fix" && project.aiPermission === "READ_ONLY") {
      throw new HttpError(403, "Project AI permission is READ_ONLY");
    }

    const job = await enqueue({
      type: body.action === "fix" ? "ai-fix" : "ai-diagnose",
      payload: { deploymentId, actor: user.email },
      dedupeKey: `${body.action}:${deploymentId}:${Date.now()}`,
      projectId,
      maxAttempts: 1,
    });
    await audit({
      orgId: project.orgId,
      projectId,
      actorId: user.id,
      action: `ai.${body.action}_requested`,
      resourceType: "deployment",
      resourceId: deploymentId,
    });
    return ok({ jobId: job?.id ?? null, queued: true });
  });
}
