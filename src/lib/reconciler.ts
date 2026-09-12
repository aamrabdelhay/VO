import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { containerInstances, deployments, hosts, projects, resourceMetrics } from "@/db/schema";
import { promoteDeployment, startFromArtifact, stopRuntime } from "@/lib/deploy";
import { getRuntimeDriver } from "@/lib/runtime";
import { publishRoutes } from "@/lib/router";
import { log } from "@/lib/logger";
import { recordEvent } from "@/lib/state-machine";

/**
 * Desired-state reconciliation. Compares what the platform *wants* with what is
 * actually observed on the data plane, and repairs drift (stuck promotions,
 * dead runtimes, orphaned containers).
 */
export async function reconcile() {
  const actions: string[] = [];
  const driver = await getRuntimeDriver();
  const allProjects = await db.select().from(projects).where(eq(projects.enabled, true));

  for (const project of allProjects) {
    // 1. Promote a healthy, still-desired deployment that never got promoted.
    if (project.desiredDeploymentId) {
      const [desired] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, project.desiredDeploymentId))
        .limit(1);
      if (
        desired &&
        desired.status === "HEALTHY" &&
        project.currentHealthyDeploymentId !== desired.id
      ) {
        const result = await promoteDeployment(desired.id, "reconciler");
        actions.push(`promote:${desired.id}:${result.ok ? "ok" : result.reason}`);
      }
    }

    // 2. Production runtime must actually be running.
    if (project.currentHealthyDeploymentId) {
      const [instance] = await db
        .select()
        .from(containerInstances)
        .where(
          and(
            eq(containerInstances.deploymentId, project.currentHealthyDeploymentId),
            eq(containerInstances.status, "running"),
          ),
        )
        .limit(1);
      if (!instance) {
        try {
          await startFromArtifact(project.currentHealthyDeploymentId);
          actions.push(`restart:${project.currentHealthyDeploymentId}`);
          await recordEvent(
            project.currentHealthyDeploymentId,
            project.id,
            "RUNTIME_RESTARTED",
            "reconciler restored the production runtime",
          );
        } catch (error) {
          log.warn("Reconciler could not restore production runtime", {
            projectId: project.id,
            error: String(error),
          });
        }
      } else if (!(await driver.running(instance.externalId))) {
        await db
          .update(containerInstances)
          .set({ status: "exited", stoppedAt: new Date() })
          .where(eq(containerInstances.id, instance.id));
        actions.push(`observed-exit:${instance.deploymentId}`);
      } else {
        await db
          .update(containerInstances)
          .set({ lastSeenAt: new Date() })
          .where(eq(containerInstances.id, instance.id));
      }
    }
  }

  // 3. Stop runtimes for deployments that are terminal but still running.
  const orphans = await db
    .select({ instance: containerInstances, deployment: deployments })
    .from(containerInstances)
    .innerJoin(deployments, eq(deployments.id, containerInstances.deploymentId))
    .where(
      and(
        eq(containerInstances.status, "running"),
        inArray(deployments.status, ["FAILED", "CANCELED", "OBSOLETE", "STOPPED"]),
      ),
    );
  for (const orphan of orphans) {
    await stopRuntime(orphan.deployment.id);
    actions.push(`stop-orphan:${orphan.deployment.id}`);
  }

  await publishRoutes();
  await db
    .insert(hosts)
    .values({
      id: process.env.PLATFORM_HOST_ID ?? "local",
      region: process.env.PLATFORM_REGION ?? "local",
      driver: driver.name,
      healthy: true,
      lastHeartbeatAt: new Date(),
    })
    .onConflictDoUpdate({
      target: hosts.id,
      set: { lastHeartbeatAt: new Date(), healthy: true, driver: driver.name },
    });

  return actions;
}

/** Low-frequency roll-ups only; high-frequency samples belong in Prometheus. */
export async function collectMetrics() {
  const driver = await getRuntimeDriver();
  const running = await db
    .select()
    .from(containerInstances)
    .where(eq(containerInstances.status, "running"));
  let recorded = 0;
  for (const instance of running) {
    const stats = await driver.stats(instance.externalId).catch(() => null);
    if (!stats) continue;
    await db.insert(resourceMetrics).values({
      projectId: instance.projectId,
      deploymentId: instance.deploymentId,
      window: "1m",
      cpuPercent: stats.cpuPercent ?? null,
      memoryMb: stats.memoryMb ?? null,
      rssMb: stats.memoryMb ?? null,
    });
    recorded += 1;
  }
  return recorded;
}

export async function latestMetrics(projectId: string, limit = 60) {
  return db
    .select()
    .from(resourceMetrics)
    .where(eq(resourceMetrics.projectId, projectId))
    .orderBy(desc(resourceMetrics.recordedAt))
    .limit(limit);
}
