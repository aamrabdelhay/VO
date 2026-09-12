import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  containerInstances,
  deploymentEvents,
  deployments,
  healthCheckResults,
} from "@/db/schema";
import { handle, ok, readJson } from "@/lib/api";
import { assertCsrf, HttpError, requireProjectAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  createDeployment,
  drainDeployment,
  promoteDeployment,
  rollbackTo,
  stopRuntime,
} from "@/lib/deploy";
import { transition } from "@/lib/state-machine";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

async function loadDeployment(deploymentId: string) {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!deployment) throw new HttpError(404, "Deployment not found");
  return deployment;
}

export async function GET(_: Request, ctx: { params: Promise<{ deploymentId: string }> }) {
  const { deploymentId } = await ctx.params;
  return handle(async () => {
    const deployment = await loadDeployment(deploymentId);
    const { project } = await requireProjectAccess(deployment.projectId);
    const events = await db
      .select()
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deploymentId, deploymentId))
      .orderBy(asc(deploymentEvents.createdAt));
    const health = await db
      .select()
      .from(healthCheckResults)
      .where(eq(healthCheckResults.deploymentId, deploymentId))
      .orderBy(desc(healthCheckResults.checkedAt))
      .limit(20);
    const [instance] = await db
      .select()
      .from(containerInstances)
      .where(
        and(
          eq(containerInstances.deploymentId, deploymentId),
          eq(containerInstances.status, "running"),
        ),
      )
      .limit(1);
    return ok({ deployment, project, events, health, instance: instance ?? null });
  });
}

type Body = { action: "rollback" | "promote" | "cancel" | "redeploy" | "stop" };

export async function POST(request: Request, ctx: { params: Promise<{ deploymentId: string }> }) {
  const { deploymentId } = await ctx.params;
  return handle(async () => {
    const deployment = await loadDeployment(deploymentId);
    const { user, project } = await requireProjectAccess(deployment.projectId, "DEVELOPER");
    await assertCsrf(user);
    const body = await readJson<Body>(request);

    switch (body.action) {
      case "rollback": {
        const target = await rollbackTo(project.id, deploymentId, user.email);
        return ok({ rolledBackTo: target.id });
      }
      case "promote": {
        const result = await promoteDeployment(deploymentId, user.email);
        if (!result.ok) throw new HttpError(409, result.reason);
        return ok({ promoted: deploymentId });
      }
      case "cancel": {
        const updated = await transition(
          deploymentId,
          "CANCELED",
          { finishedAt: new Date() },
          { event: "DEPLOYMENT_CANCELED", message: `canceled by ${user.email}` },
        );
        if (!updated) throw new HttpError(409, "Deployment cannot be canceled in its current state");
        await stopRuntime(deploymentId);
        await audit({
          orgId: project.orgId,
          projectId: project.id,
          actorId: user.id,
          action: "deployment.canceled",
          resourceType: "deployment",
          resourceId: deploymentId,
        });
        return ok({ canceled: true });
      }
      case "stop": {
        if (project.currentHealthyDeploymentId === deploymentId) {
          throw new HttpError(409, "Cannot stop the deployment currently serving production");
        }
        await drainDeployment(deploymentId);
        return ok({ stopped: true });
      }
      case "redeploy": {
        const fresh = await createDeployment({
          project,
          commitSha: deployment.commitSha,
          branch: deployment.branch,
          target: deployment.target as "PRODUCTION" | "PREVIEW",
          commitMessage: deployment.commitMessage,
          commitAuthor: deployment.commitAuthor,
          triggeredBy: user.email,
          triggerSource: "dashboard-redeploy",
        });
        return ok({ deployment: fresh });
      }
      default:
        throw new HttpError(400, "Unsupported action");
    }
  });
}
