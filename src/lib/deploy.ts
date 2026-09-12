import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  containerInstances,
  deployments,
  domains,
  envVars,
  projects,
  incidents,
} from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { DeploymentLogger } from "@/lib/deployment-logs";
import { detectFramework, mergeConfig } from "@/lib/framework";
import { fetchCommitTarball } from "@/lib/github";
import { waitForHealthy, probe, recordLiveness } from "@/lib/health";
import { log } from "@/lib/logger";
import { enqueue } from "@/lib/queue";
import {
  deploymentHost,
  platformHost,
  previewHost,
  publishRoutes,
} from "@/lib/router";
import { getRuntimeDriver, parseCommand, runCommand, allocatePort } from "@/lib/runtime";
import { daysFromNow, registerArtifact, storage, STORAGE_ROOT } from "@/lib/storage";
import { transition, recordEvent, type DeploymentStatus } from "@/lib/state-machine";
import { audit, notify } from "@/lib/audit";
import { installationToken } from "@/lib/github-auth";

type Project = typeof projects.$inferSelect;
type Deployment = typeof deployments.$inferSelect;

export const WORKSPACE_ROOT =
  process.env.PLATFORM_WORKSPACE_ROOT ?? path.join(process.cwd(), ".platform", "workspaces");

const NON_TERMINAL: DeploymentStatus[] = [
  "QUEUED",
  "CLONING",
  "BUILDING",
  "TESTING",
  "BUILT",
  "STARTING",
  "HEALTH_CHECKING",
  "HEALTHY",
];

export function bundleKey(projectId: string, deploymentId: string) {
  return `bundles/${projectId}/${deploymentId}`;
}

export function bundlePath(projectId: string, deploymentId: string) {
  return path.join(STORAGE_ROOT, bundleKey(projectId, deploymentId));
}

export async function projectEnv(projectId: string, scope: "PRODUCTION" | "PREVIEW") {
  const rows = await db
    .select()
    .from(envVars)
    .where(and(eq(envVars.projectId, projectId), inArray(envVars.scope, [scope])));
  const env: Record<string, string> = {};
  for (const row of rows) env[row.key] = decryptSecret(row.cipher);
  return env;
}

/* ------------------------------------------------------------- creation */

export type CreateDeploymentInput = {
  project: Project;
  commitSha: string;
  branch: string;
  target: "PRODUCTION" | "PREVIEW";
  commitMessage?: string | null;
  commitAuthor?: string | null;
  commitTimestamp?: Date | null;
  prNumber?: number | null;
  triggeredBy?: string;
  triggerSource?: string;
  correlationId?: string | null;
  aiFixOfDeploymentId?: string | null;
};

/**
 * Creates a deployment, advances desired state and enqueues the pipeline.
 * Idempotent per (project, commit, generation).
 */
export async function createDeployment(input: CreateDeploymentInput) {
  const { project } = input;
  if (!project.enabled) throw new Error("Project is disabled");

  const isProduction = input.target === "PRODUCTION";
  const generation = isProduction ? project.deploymentGeneration + 1 : project.deploymentGeneration;

  const [counter] = await db
    .update(projects)
    .set({
      deploymentCounter: sql`${projects.deploymentCounter} + 1`,
      ...(isProduction
        ? { desiredCommitSha: input.commitSha, deploymentGeneration: generation }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, project.id))
    .returning({ number: projects.deploymentCounter });

  const existing = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.projectId, project.id),
        eq(deployments.commitSha, input.commitSha),
        eq(deployments.generation, generation),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const [deployment] = await db
    .insert(deployments)
    .values({
      projectId: project.id,
      number: counter.number,
      target: input.target,
      status: "QUEUED",
      generation,
      branch: input.branch,
      commitSha: input.commitSha,
      commitMessage: input.commitMessage ?? null,
      commitAuthor: input.commitAuthor ?? null,
      commitTimestamp: input.commitTimestamp ?? null,
      prNumber: input.prNumber ?? null,
      triggeredBy: input.triggeredBy ?? "system",
      triggerSource: input.triggerSource ?? "manual",
      correlationId: input.correlationId ?? null,
      aiFixOfDeploymentId: input.aiFixOfDeploymentId ?? null,
      configSnapshot: {
        configVersion: project.configVersion,
        rootDirectory: project.rootDirectory,
        installCommand: project.installCommand,
        buildCommand: project.buildCommand,
        startCommand: project.startCommand,
        testCommand: project.testCommand,
        nodeVersion: project.nodeVersion,
        healthPath: project.healthPath,
      },
    })
    .returning();

  if (isProduction) {
    await db
      .update(projects)
      .set({ desiredDeploymentId: deployment.id, updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    await markStaleDeploymentsObsolete(project.id, deployment.id);
  }

  await recordEvent(
    deployment.id,
    project.id,
    "DEPLOYMENT_CREATED",
    `${input.target} deployment for ${input.commitSha.slice(0, 7)} on ${input.branch}`,
    { triggerSource: input.triggerSource },
    input.correlationId,
  );

  await enqueue({
    type: "deploy",
    payload: { deploymentId: deployment.id },
    dedupeKey: `deploy:${deployment.id}`,
    projectId: project.id,
    correlationId: input.correlationId ?? deployment.id,
    maxAttempts: 1, // deterministic build failures are not retried blindly
  });

  return deployment;
}

/** Any in-flight production work for an older commit is obsoleted, never promoted. */
export async function markStaleDeploymentsObsolete(projectId: string, keepDeploymentId: string) {
  const stale = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.projectId, projectId),
        eq(deployments.target, "PRODUCTION"),
        ne(deployments.id, keepDeploymentId),
        inArray(deployments.status, NON_TERMINAL),
      ),
    );
  for (const d of stale) {
    await transition(d.id, "OBSOLETE", { finishedAt: new Date() }, {
      event: "DEPLOYMENT_OBSOLETE",
      message: "Superseded by a newer desired commit",
    });
    await stopRuntime(d.id).catch(() => undefined);
  }
  return stale.length;
}

/* --------------------------------------------------------------- pipeline */

export async function runDeploymentPipeline(deploymentId: string) {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!deployment) return { ok: false, reason: "deployment not found" };
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, deployment.projectId))
    .limit(1);
  if (!project) return { ok: false, reason: "project not found" };

  if (deployment.status !== "QUEUED") {
    return { ok: false, reason: `deployment already ${deployment.status}` };
  }
  const staleCheck = await assertStillDesired(project.id, deployment);
  if (!staleCheck.ok) return { ok: false, reason: staleCheck.reason };

  const env =
    deployment.target === "PRODUCTION"
      ? await projectEnv(project.id, "PRODUCTION")
      : await projectEnv(project.id, "PREVIEW");
  const logger = new DeploymentLogger(deployment.id, project.id, Object.values(env));
  const workspace = path.join(WORKSPACE_ROOT, deployment.id);
  const logCtx = { projectId: project.id, deploymentId: deployment.id, service: "worker" };

  try {
    /* ---------------------------------------------------------- clone */
    await transition(deployment.id, "CLONING", { buildStartedAt: new Date() }, {
      event: "BUILD_STARTED",
    });
    await logger.write(`Fetching ${project.repoFullName}@${deployment.commitSha}`);
    await fs.rm(workspace, { recursive: true, force: true });
    const token = await installationToken(project.orgId);
    await fetchCommitTarball(project.repoFullName, deployment.commitSha, workspace, token);
    const root = path.join(workspace, project.rootDirectory || ".");
    await logger.write(`Source materialised at commit ${deployment.commitSha}`);

    /* ------------------------------------------------ framework detect */
    const detected = await detectFramework(root);
    const config = mergeConfig(detected, {
      packageManager: project.packageManager,
      installCommand: project.installCommand,
      buildCommand: project.buildCommand,
      startCommand: project.startCommand,
      testCommand: project.testCommand,
      outputDirectory: project.outputDirectory,
      framework: project.framework,
    });
    await logger.write(`Detected framework: ${detected.framework} (${detected.packageManager})`);
    if (!project.framework) {
      await db
        .update(projects)
        .set({ framework: detected.framework, packageManager: detected.packageManager })
        .where(eq(projects.id, project.id));
    }

    /* -------------------------------------------------------- install */
    await transition(deployment.id, "BUILDING");
    const buildEnv = { ...env, NODE_ENV: "production" };
    if (config.installCommand) {
      await logger.write(`$ ${config.installCommand}`);
      const install = parseCommand(config.installCommand);
      const res = await runCommand(install.file, install.args, {
        cwd: root,
        env: { ...buildEnv, NODE_ENV: "development" },
        timeoutMs: project.buildTimeoutMs,
        onOutput: (chunk) => logger.write(chunk, "build"),
      });
      if (res.code !== 0) throw new BuildError(`Install failed with exit code ${res.code}`);
    }

    /* ----------------------------------------------------------- test */
    if (config.testCommand && project.testCommand) {
      await transition(deployment.id, "TESTING");
      await logger.write(`$ ${config.testCommand}`);
      const test = parseCommand(config.testCommand);
      const res = await runCommand(test.file, test.args, {
        cwd: root,
        env: buildEnv,
        timeoutMs: project.buildTimeoutMs,
        onOutput: (chunk) => logger.write(chunk, "test"),
      });
      if (res.code !== 0) throw new BuildError(`Tests failed with exit code ${res.code}`);
    }

    /* ---------------------------------------------------------- build */
    if (config.buildCommand) {
      await logger.write(`$ ${config.buildCommand}`);
      const build = parseCommand(config.buildCommand);
      const res = await runCommand(build.file, build.args, {
        cwd: root,
        env: buildEnv,
        timeoutMs: project.buildTimeoutMs,
        onOutput: (chunk) => logger.write(chunk, "build"),
      });
      if (res.code !== 0) throw new BuildError(`Build failed with exit code ${res.code}`);
    }

    /* ----------------------------------------- immutable artifact */
    const key = bundleKey(project.id, deployment.id);
    const target = bundlePath(project.id, deployment.id);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(root, target).catch(async () => {
      await runCommand("cp", ["-a", root, target], { cwd: process.cwd(), timeoutMs: 120000 });
    });
    await fs.rm(workspace, { recursive: true, force: true }); // ephemeral workspace removed
    const size = await storage.size(key);
    await registerArtifact({
      projectId: project.id,
      deploymentId: deployment.id,
      type: "BUNDLE",
      storageKey: key,
      sizeBytes: size,
      expiresAt:
        deployment.target === "PREVIEW" ? daysFromNow(project.previewRetentionDays) : null,
    });
    await logger.write(`Artifact stored (${(size / 1024 / 1024).toFixed(1)} MB) key=${key}`);
    await transition(deployment.id, "BUILT", {
      artifactRef: key,
      imageRef: `${project.slug}/${deployment.id}:${deployment.commitSha.slice(0, 12)}`,
      buildEndedAt: new Date(),
    }, { event: "BUILD_SUCCEEDED" });

    /* --------------------------------------------------------- start */
    const stillDesired = await assertStillDesired(project.id, deployment);
    if (!stillDesired.ok) {
      await transition(deployment.id, "OBSOLETE", { finishedAt: new Date() }, {
        event: "DEPLOYMENT_OBSOLETE",
        message: stillDesired.reason,
      });
      await logger.flush(project.logRetentionDays);
      return { ok: false, reason: stillDesired.reason };
    }

    await transition(deployment.id, "STARTING");
    const port = await allocatePort();
    const driver = await getRuntimeDriver();
    const handle = await driver.start({
      projectId: project.id,
      deploymentId: deployment.id,
      workspace: target,
      command: config.startCommand,
      port,
      env: { ...env, NODE_ENV: "production" },
      memoryLimitMb: project.memoryLimitMb,
      cpuLimit: project.cpuLimit,
      pidsLimit: project.pidsLimit,
      imageRef: null,
    });
    await db.insert(containerInstances).values({
      projectId: project.id,
      deploymentId: deployment.id,
      driver: handle.driver,
      externalId: handle.externalId,
      port,
      pid: handle.pid ?? null,
      status: "running",
      lastSeenAt: new Date(),
    });
    await db
      .update(deployments)
      .set({ port, runtimeDriver: handle.driver, updatedAt: new Date() })
      .where(eq(deployments.id, deployment.id));
    await recordEvent(deployment.id, project.id, "CONTAINER_STARTED", `runtime on port ${port}`);
    await logger.write(`Runtime started via ${handle.driver} driver on port ${port}`);

    /* -------------------------------------------------- health check */
    await transition(deployment.id, "HEALTH_CHECKING");
    const health = await waitForHealthy(
      { projectId: project.id, deploymentId: deployment.id, port },
      {
        path: project.healthPath,
        expectedStatus: project.healthExpectedStatus,
        timeoutMs: project.healthTimeoutMs,
        initialDelayMs: project.healthInitialDelayMs,
        intervalMs: project.healthIntervalMs,
        retries: project.healthRetries,
      },
      async (attempt, result) => {
        if (attempt % 5 === 0 || result.ok) {
          await logger.write(
            `Health probe #${attempt}: ${result.ok ? "ok" : "failed"} ${result.statusCode ?? result.error ?? ""}`,
            "health",
            result.ok ? "info" : "warn",
          );
        }
      },
    );
    if (!health.ok) {
      await recordEvent(deployment.id, project.id, "HEALTH_CHECK_FAILED", health.error ?? "unhealthy");
      throw new BuildError(`Health check failed: ${health.error ?? `status ${health.statusCode}`}`);
    }
    await recordEvent(deployment.id, project.id, "HEALTH_CHECK_SUCCEEDED");
    await transition(deployment.id, "HEALTHY", { healthyAt: new Date() });

    /* -------------------------------------------------------- promote */
    const url =
      deployment.target === "PRODUCTION"
        ? `https://${platformHost(project.slug)}`
        : `https://${previewHost(project.slug, deployment.prNumber, deployment.branch)}`;
    await db
      .update(deployments)
      .set({ url, updatedAt: new Date() })
      .where(eq(deployments.id, deployment.id));

    if (deployment.target === "PREVIEW") {
      await publishRoutes();
      await logger.write(`Preview ready at ${url}`);
      await logger.flush(project.logRetentionDays);
      await notify({
        orgId: project.orgId,
        projectId: project.id,
        type: "preview.ready",
        severity: "success",
        title: `Preview ready for ${project.name}`,
        body: url,
      });
      await enqueue({
        type: "preview-expire",
        payload: { deploymentId: deployment.id },
        dedupeKey: `preview-expire:${deployment.id}`,
        projectId: project.id,
        runAt: daysFromNow(project.previewRetentionDays),
      });
      return { ok: true, deploymentId: deployment.id, url };
    }

    const promoted = await promoteDeployment(deployment.id, "pipeline");
    if (!promoted.ok) {
      await logger.write(`Promotion skipped: ${promoted.reason}`, "deploy", "warn");
      await logger.flush(project.logRetentionDays);
      return promoted;
    }
    await logger.write(`Promoted to production at ${url}`);
    await logger.flush(project.logRetentionDays);
    return { ok: true, deploymentId: deployment.id, url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("Deployment failed", { ...logCtx, error: message });
    await logger.write(message, "deploy", "error");
    await logger.flush(project.logRetentionDays).catch(() => undefined);
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    await stopRuntime(deployment.id).catch(() => undefined);
    await transition(
      deployment.id,
      "FAILED",
      { errorReason: message.slice(0, 1000), finishedAt: new Date(), buildEndedAt: new Date() },
      { event: "DEPLOYMENT_FAILED", message },
    );
    await db
      .update(projects)
      .set({ lastFailedCommitSha: deployment.commitSha, updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    await notify({
      orgId: project.orgId,
      projectId: project.id,
      type: "deployment.failed",
      severity: "error",
      title: `Deployment failed: ${project.name}`,
      body: `${deployment.commitSha.slice(0, 7)} — ${message.slice(0, 200)}`,
    });
    // Production is untouched: currentHealthyDeploymentId is not modified here.
    if (project.aiAutoDiagnose) {
      await enqueue({
        type: "ai-diagnose",
        payload: { deploymentId: deployment.id },
        dedupeKey: `ai-diagnose:${deployment.id}`,
        projectId: project.id,
        maxAttempts: 1,
      });
    }
    return { ok: false, reason: message };
  }
}

export class BuildError extends Error {}

export async function assertStillDesired(projectId: string, deployment: Deployment) {
  if (deployment.target === "PREVIEW") return { ok: true as const, reason: "" };
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return { ok: false as const, reason: "project missing" };
  if (!project.enabled) return { ok: false as const, reason: "project disabled" };
  if (project.desiredCommitSha && project.desiredCommitSha !== deployment.commitSha) {
    return { ok: false as const, reason: "desired commit changed" };
  }
  if (deployment.generation < project.deploymentGeneration) {
    return { ok: false as const, reason: "superseded by newer deployment generation" };
  }
  return { ok: true as const, reason: "" };
}

/* -------------------------------------------------------------- promote */

export async function promoteDeployment(deploymentId: string, actor: string) {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!deployment) return { ok: false as const, reason: "deployment not found" };
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, deployment.projectId))
    .limit(1);
  if (!project) return { ok: false as const, reason: "project not found" };

  if (!["HEALTHY", "ROLLED_BACK", "STOPPED"].includes(deployment.status)) {
    return { ok: false as const, reason: `deployment is ${deployment.status}, not healthy` };
  }
  if (!deployment.artifactRef) return { ok: false as const, reason: "artifact missing" };
  const desired = await assertStillDesired(project.id, deployment);
  if (!desired.ok) {
    await transition(deploymentId, "OBSOLETE", { finishedAt: new Date() }, {
      event: "DEPLOYMENT_OBSOLETE",
      message: desired.reason,
    });
    return { ok: false as const, reason: desired.reason };
  }
  const [instance] = await db
    .select()
    .from(containerInstances)
    .where(
      and(eq(containerInstances.deploymentId, deploymentId), eq(containerInstances.status, "running")),
    )
    .limit(1);
  if (!instance) return { ok: false as const, reason: "runtime is not running" };

  const previousId = project.currentHealthyDeploymentId;
  await transition(deploymentId, "PROMOTING", {}, { event: "PROMOTION_STARTED" });

  await db
    .update(projects)
    .set({
      currentHealthyDeploymentId: deploymentId,
      lastSuccessfulCommitSha: deployment.commitSha,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, project.id));
  await transition(deploymentId, "PROMOTED", { promotedAt: new Date() }, { event: "PROMOTED" });
  await publishRoutes(); // atomic routing swap

  await audit({
    orgId: project.orgId,
    projectId: project.id,
    actorId: actor,
    actorType: actor === "pipeline" ? "system" : "user",
    action: "deployment.promoted",
    resourceType: "deployment",
    resourceId: deploymentId,
    oldState: { currentHealthyDeploymentId: previousId },
    newState: { currentHealthyDeploymentId: deploymentId },
  });
  await notify({
    orgId: project.orgId,
    projectId: project.id,
    type: "deployment.promoted",
    severity: "success",
    title: `Deployed ${project.name}`,
    body: `${deployment.commitSha.slice(0, 7)} is live`,
  });

  if (previousId && previousId !== deploymentId) {
    await enqueue({
      type: "deploy",
      payload: { action: "drain", deploymentId: previousId },
      dedupeKey: `drain:${previousId}:${Date.now()}`,
      projectId: project.id,
      runAt: new Date(Date.now() + 15_000), // grace period for in-flight requests
    });
  }
  await enqueue({
    type: "post-promotion-monitor",
    payload: { deploymentId, until: Date.now() + project.postPromotionWindowMs },
    dedupeKey: `monitor:${deploymentId}`,
    projectId: project.id,
    runAt: new Date(Date.now() + 15_000),
    maxAttempts: 1,
  });
  return { ok: true as const, deploymentId };
}

/* ---------------------------------------------------------------- drain */

export async function drainDeployment(deploymentId: string) {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!deployment) return;
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, deployment.projectId))
    .limit(1);
  // Never drain the deployment that is currently serving production.
  if (project?.currentHealthyDeploymentId === deploymentId) return;
  await transition(deploymentId, "DRAINING", {}, { event: "DRAIN_STARTED" });
  await stopRuntime(deploymentId);
  await transition(deploymentId, "STOPPED", { stoppedAt: new Date() }, { event: "DRAINED" });
  await publishRoutes();
}

export async function stopRuntime(deploymentId: string) {
  const instances = await db
    .select()
    .from(containerInstances)
    .where(
      and(eq(containerInstances.deploymentId, deploymentId), eq(containerInstances.status, "running")),
    );
  const driver = await getRuntimeDriver();
  for (const instance of instances) {
    await driver.stop(instance.externalId).catch(() => undefined);
    await db
      .update(containerInstances)
      .set({ status: "stopped", stoppedAt: new Date() })
      .where(eq(containerInstances.id, instance.id));
  }
}

/* -------------------------------------------------------------- restart */

/** Starts a retained deployment again from its immutable artifact. */
export async function startFromArtifact(deploymentId: string) {
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
  if (!deployment.artifactRef) throw new Error("Artifact no longer exists");

  const dir = path.join(STORAGE_ROOT, deployment.artifactRef);
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat) throw new Error("Artifact no longer exists on storage");

  const existing = await db
    .select()
    .from(containerInstances)
    .where(
      and(eq(containerInstances.deploymentId, deploymentId), eq(containerInstances.status, "running")),
    )
    .limit(1);
  if (existing[0]) return existing[0].port;

  const env = await projectEnv(
    project.id,
    deployment.target === "PREVIEW" ? "PREVIEW" : "PRODUCTION",
  );
  const detected = await detectFramework(dir);
  const startCommand = project.startCommand || detected.startCommand;
  const port = await allocatePort();
  const driver = await getRuntimeDriver();
  const handle = await driver.start({
    projectId: project.id,
    deploymentId,
    workspace: dir,
    command: startCommand,
    port,
    env: { ...env, NODE_ENV: "production" },
    memoryLimitMb: project.memoryLimitMb,
    cpuLimit: project.cpuLimit,
    pidsLimit: project.pidsLimit,
    imageRef: deployment.imageRef,
  });
  await db.insert(containerInstances).values({
    projectId: project.id,
    deploymentId,
    driver: handle.driver,
    externalId: handle.externalId,
    port,
    pid: handle.pid ?? null,
    status: "running",
    lastSeenAt: new Date(),
  });
  await db
    .update(deployments)
    .set({ port, runtimeDriver: handle.driver, updatedAt: new Date() })
    .where(eq(deployments.id, deploymentId));
  await recordEvent(deploymentId, project.id, "CONTAINER_STARTED", `restarted on port ${port}`);

  const health = await waitForHealthy(
    { projectId: project.id, deploymentId, port },
    {
      path: project.healthPath,
      expectedStatus: project.healthExpectedStatus,
      timeoutMs: project.healthTimeoutMs,
      initialDelayMs: project.healthInitialDelayMs,
      intervalMs: project.healthIntervalMs,
      retries: project.healthRetries,
    },
  );
  if (!health.ok) {
    await stopRuntime(deploymentId);
    throw new Error(`Restarted deployment failed health check: ${health.error ?? health.statusCode}`);
  }
  return port;
}

/* -------------------------------------------------------------- rollback */

export async function rollbackTo(projectId: string, targetDeploymentId: string, actor: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error("Project not found");
  const [target] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, targetDeploymentId), eq(deployments.projectId, projectId)))
    .limit(1);
  if (!target) throw new Error("Target deployment not found");
  if (target.target !== "PRODUCTION") throw new Error("Only production deployments can be promoted");
  if (!target.artifactRef) throw new Error("Target artifact is no longer retained");

  const previousId = project.currentHealthyDeploymentId;
  await recordEvent(targetDeploymentId, projectId, "ROLLBACK_STARTED", `requested by ${actor}`);

  // Re-start from the immutable artifact and health check before switching.
  await startFromArtifact(targetDeploymentId);
  if (target.status === "STOPPED" || target.status === "ROLLED_BACK") {
    await transition(targetDeploymentId, "STARTING");
    await transition(targetDeploymentId, "HEALTH_CHECKING");
    await transition(targetDeploymentId, "HEALTHY", { healthyAt: new Date() });
  }

  // Rollback intentionally points desired state at the retained commit.
  await db
    .update(projects)
    .set({
      desiredCommitSha: target.commitSha,
      desiredDeploymentId: target.id,
      deploymentGeneration: project.deploymentGeneration + 1,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));
  await db
    .update(deployments)
    .set({ generation: project.deploymentGeneration + 1 })
    .where(eq(deployments.id, targetDeploymentId));

  const result = await promoteDeployment(targetDeploymentId, actor);
  if (!result.ok) throw new Error(`Rollback failed: ${result.reason}`);

  if (previousId && previousId !== targetDeploymentId) {
    await transition(previousId, "ROLLED_BACK", {}, { event: "ROLLED_BACK" });
    await enqueue({
      type: "deploy",
      payload: { action: "drain", deploymentId: previousId },
      dedupeKey: `drain:${previousId}:${Date.now()}`,
      projectId,
      runAt: new Date(Date.now() + 10_000),
    });
  }
  await recordEvent(targetDeploymentId, projectId, "ROLLED_BACK", `rolled back by ${actor}`);
  await audit({
    orgId: project.orgId,
    projectId,
    actorId: actor,
    action: "deployment.rollback",
    resourceType: "deployment",
    resourceId: targetDeploymentId,
    oldState: { currentHealthyDeploymentId: previousId },
    newState: { currentHealthyDeploymentId: targetDeploymentId },
  });
  await notify({
    orgId: project.orgId,
    projectId,
    type: "deployment.rollback",
    severity: "warning",
    title: `Rollback completed for ${project.name}`,
    body: `Now serving ${target.commitSha.slice(0, 7)}`,
  });
  return target;
}

/** Post-promotion monitoring with bounded automatic rollback. */
export async function monitorAfterPromotion(deploymentId: string, until: number) {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!deployment || deployment.status !== "PROMOTED") return { ok: true, checked: 0 };
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, deployment.projectId))
    .limit(1);
  if (!project || project.currentHealthyDeploymentId !== deploymentId) return { ok: true, checked: 0 };

  const [instance] = await db
    .select()
    .from(containerInstances)
    .where(
      and(eq(containerInstances.deploymentId, deploymentId), eq(containerInstances.status, "running")),
    )
    .limit(1);
  if (!instance) return { ok: true, checked: 0 };

  let failures = 0;
  let checks = 0;
  while (Date.now() < until && failures < 3) {
    const result = await probe(instance.port, {
      path: project.healthPath,
      expectedStatus: project.healthExpectedStatus,
      timeoutMs: project.healthTimeoutMs,
    });
    await recordLiveness(project.id, deploymentId, result);
    checks += 1;
    failures = result.ok ? 0 : failures + 1;
    await new Promise((r) => setTimeout(r, Math.max(2000, project.healthIntervalMs)));
  }

  if (failures >= 3 && project.autoRollback) {
    await db.insert(incidents).values({
      projectId: project.id,
      severity: "critical",
      kind: "post_promotion_health_failure",
      title: `${project.name} became unhealthy after promotion`,
      cause: `Deployment ${deploymentId.slice(0, 8)} failed ${failures} consecutive liveness probes`,
      actions: { autoRollback: true },
    });
    const candidates = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, project.id),
          eq(deployments.target, "PRODUCTION"),
          ne(deployments.id, deploymentId),
          inArray(deployments.status, ["ROLLED_BACK", "STOPPED", "PROMOTED"]),
        ),
      )
      .orderBy(desc(deployments.promotedAt))
      .limit(5);
    const candidate = candidates.find((c) => c.artifactRef);
    if (candidate) {
      await rollbackTo(project.id, candidate.id, "auto-rollback").catch(async (e) => {
        await notify({
          orgId: project.orgId,
          projectId: project.id,
          type: "deployment.rollback_failed",
          severity: "error",
          title: `Automatic rollback failed for ${project.name}`,
          body: String(e),
        });
      });
    }
    return { ok: false, checked: checks };
  }
  return { ok: true, checked: checks };
}

/** Preview teardown: runtime stops, metadata and history are retained. */
export async function expirePreview(deploymentId: string, reason: string) {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!deployment || deployment.target !== "PREVIEW") return;
  await stopRuntime(deploymentId);
  if (!["STOPPED", "FAILED", "CANCELED", "OBSOLETE"].includes(deployment.status)) {
    await transition(deploymentId, "STOPPED", { stoppedAt: new Date() }, {
      event: "PREVIEW_EXPIRED",
      message: reason,
    });
  }
  await db.delete(domains).where(
    and(eq(domains.projectId, deployment.projectId), eq(domains.deploymentId, deploymentId)),
  );
  await publishRoutes();
}

export function deploymentUrlFor(project: Project, deployment: Deployment) {
  if (deployment.target === "PREVIEW") {
    return `https://${previewHost(project.slug, deployment.prNumber, deployment.branch)}`;
  }
  return `https://${deploymentHost(deployment.id, project.slug)}`;
}
