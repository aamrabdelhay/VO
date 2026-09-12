import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  cleanupRuns,
  containerInstances,
  deploymentArtifacts,
  deployments,
  projects,
  organizations,
  notifications,
} from "@/db/schema";
import { WORKSPACE_ROOT, expirePreview, stopRuntime } from "@/lib/deploy";
import { purgeLogChunksBefore } from "@/lib/deployment-logs";
import { log } from "@/lib/logger";
import { storage } from "@/lib/storage";

export type CleanupSummary = {
  kind: string;
  scanned: number;
  deleted: number;
  skipped: number;
  bytesReclaimed: number;
  detail: Record<string, unknown>;
};

/**
 * Set of artifacts that must never be garbage collected: production, rollback
 * retention window, active previews and anything with a running runtime.
 */
export async function protectedDeploymentIds(): Promise<Set<string>> {
  const protectedIds = new Set<string>();
  const allProjects = await db.select().from(projects);
  for (const project of allProjects) {
    if (project.currentHealthyDeploymentId) protectedIds.add(project.currentHealthyDeploymentId);
    if (project.desiredDeploymentId) protectedIds.add(project.desiredDeploymentId);
    const retained = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, project.id),
          eq(deployments.target, "PRODUCTION"),
          inArray(deployments.status, ["PROMOTED", "ROLLED_BACK", "STOPPED", "HEALTHY"]),
        ),
      )
      .orderBy(desc(deployments.promotedAt), desc(deployments.queuedAt))
      .limit(project.retainProductionDeployments);
    retained.forEach((r) => protectedIds.add(r.id));
  }
  const running = await db
    .select({ id: containerInstances.deploymentId })
    .from(containerInstances)
    .where(eq(containerInstances.status, "running"));
  running.forEach((r) => protectedIds.add(r.id));

  const inFlight = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      inArray(deployments.status, [
        "QUEUED",
        "CLONING",
        "BUILDING",
        "TESTING",
        "BUILT",
        "STARTING",
        "HEALTH_CHECKING",
        "HEALTHY",
        "PROMOTING",
        "PROMOTED",
      ]),
    );
  inFlight.forEach((r) => protectedIds.add(r.id));
  return protectedIds;
}

async function record(summary: CleanupSummary, error?: string) {
  await db.insert(cleanupRuns).values({
    kind: summary.kind,
    status: error ? "failed" : "succeeded",
    itemsScanned: summary.scanned,
    itemsDeleted: summary.deleted,
    itemsSkipped: summary.skipped,
    bytesReclaimed: summary.bytesReclaimed,
    detail: summary.detail,
    error: error ?? null,
    finishedAt: new Date(),
  });
}

/** Removes ephemeral build workspaces that are no longer attached to a live build. */
export async function cleanupWorkspaces(): Promise<CleanupSummary> {
  const summary: CleanupSummary = {
    kind: "workspaces",
    scanned: 0,
    deleted: 0,
    skipped: 0,
    bytesReclaimed: 0,
    detail: {},
  };
  const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true }).catch(() => []);
  const active = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(inArray(deployments.status, ["QUEUED", "CLONING", "BUILDING", "TESTING", "BUILT"]));
  const activeIds = new Set(active.map((a) => a.id));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    summary.scanned += 1;
    if (activeIds.has(entry.name)) {
      summary.skipped += 1;
      continue;
    }
    const full = path.join(WORKSPACE_ROOT, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    await fs.rm(full, { recursive: true, force: true });
    summary.deleted += 1;
    summary.bytesReclaimed += stat?.size ?? 0;
  }
  await record(summary);
  return summary;
}

/** Expires preview runtimes past their retention window. */
export async function cleanupPreviews(): Promise<CleanupSummary> {
  const summary: CleanupSummary = {
    kind: "previews",
    scanned: 0,
    deleted: 0,
    skipped: 0,
    bytesReclaimed: 0,
    detail: {},
  };
  const rows = await db
    .select({ deployment: deployments, project: projects })
    .from(deployments)
    .innerJoin(projects, eq(projects.id, deployments.projectId))
    .where(
      and(
        eq(deployments.target, "PREVIEW"),
        inArray(deployments.status, ["PROMOTED", "HEALTHY", "BUILT", "STARTING", "HEALTH_CHECKING"]),
      ),
    );
  for (const row of rows) {
    summary.scanned += 1;
    const age = Date.now() - new Date(row.deployment.queuedAt).getTime();
    if (age < row.project.previewRetentionDays * 86_400_000) {
      summary.skipped += 1;
      continue;
    }
    await expirePreview(row.deployment.id, "preview retention window elapsed");
    summary.deleted += 1;
  }
  await record(summary);
  return summary;
}

/** Deletes expired / unreferenced artifacts. Reference checks, never age alone. */
export async function cleanupArtifacts(): Promise<CleanupSummary> {
  const summary: CleanupSummary = {
    kind: "artifacts",
    scanned: 0,
    deleted: 0,
    skipped: 0,
    bytesReclaimed: 0,
    detail: {},
  };
  const protectedIds = await protectedDeploymentIds();
  const rows = await db
    .select({ artifact: deploymentArtifacts, deployment: deployments })
    .from(deploymentArtifacts)
    .leftJoin(deployments, eq(deployments.id, deploymentArtifacts.deploymentId))
    .where(isNull(deploymentArtifacts.deletedAt));

  for (const row of rows) {
    summary.scanned += 1;
    const artifact = row.artifact;
    const deploymentId = artifact.deploymentId;
    if (deploymentId && protectedIds.has(deploymentId)) {
      summary.skipped += 1;
      continue;
    }
    const expired = artifact.expiresAt ? new Date(artifact.expiresAt).getTime() < Date.now() : false;
    const orphan = Boolean(deploymentId) && !row.deployment;
    const retiredBundle =
      artifact.type === "BUNDLE" && Boolean(deploymentId) && !protectedIds.has(deploymentId!);
    if (!expired && !orphan && !retiredBundle) {
      summary.skipped += 1;
      continue;
    }
    const bytes = await storage.delete(artifact.storageKey);
    await db
      .update(deploymentArtifacts)
      .set({ deletedAt: new Date(), sizeBytes: 0 })
      .where(eq(deploymentArtifacts.id, artifact.id));
    if (deploymentId && artifact.type === "BUNDLE") {
      await db
        .update(deployments)
        .set({ artifactRef: null })
        .where(eq(deployments.id, deploymentId));
    }
    summary.deleted += 1;
    summary.bytesReclaimed += bytes || artifact.sizeBytes;
  }
  await record(summary);
  return summary;
}

/** Prunes durable log chunks beyond the per-project retention window. */
export async function cleanupLogs(): Promise<CleanupSummary> {
  const summary: CleanupSummary = {
    kind: "logs",
    scanned: 0,
    deleted: 0,
    skipped: 0,
    bytesReclaimed: 0,
    detail: {},
  };
  const oldest = await db
    .select({ days: sql<number>`min(${projects.logRetentionDays})` })
    .from(projects);
  const days = oldest[0]?.days ?? 90;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  summary.deleted = await purgeLogChunksBefore(cutoff);
  const expiredLogs = await db
    .select()
    .from(deploymentArtifacts)
    .where(
      and(
        eq(deploymentArtifacts.type, "LOG"),
        isNull(deploymentArtifacts.deletedAt),
        lt(deploymentArtifacts.expiresAt, new Date()),
      ),
    );
  for (const artifact of expiredLogs) {
    summary.scanned += 1;
    summary.bytesReclaimed += await storage.delete(artifact.storageKey);
    await db
      .update(deploymentArtifacts)
      .set({ deletedAt: new Date(), sizeBytes: 0 })
      .where(eq(deploymentArtifacts.id, artifact.id));
    summary.deleted += 1;
  }
  await record(summary);
  return summary;
}

/** Stops runtimes belonging to deployments that are no longer referenced. */
export async function cleanupContainers(): Promise<CleanupSummary> {
  const summary: CleanupSummary = {
    kind: "containers",
    scanned: 0,
    deleted: 0,
    skipped: 0,
    bytesReclaimed: 0,
    detail: {},
  };
  const protectedIds = await protectedDeploymentIds();
  const running = await db
    .select()
    .from(containerInstances)
    .where(eq(containerInstances.status, "running"));
  for (const instance of running) {
    summary.scanned += 1;
    if (protectedIds.has(instance.deploymentId)) {
      summary.skipped += 1;
      continue;
    }
    await stopRuntime(instance.deploymentId);
    summary.deleted += 1;
  }
  await record(summary);
  return summary;
}

export async function runAllCleanup() {
  const results: CleanupSummary[] = [];
  for (const fn of [cleanupWorkspaces, cleanupPreviews, cleanupContainers, cleanupArtifacts, cleanupLogs]) {
    try {
      results.push(await fn());
    } catch (error) {
      log.error("Cleanup task failed", { task: fn.name, error: String(error) });
      await record(
        { kind: fn.name, scanned: 0, deleted: 0, skipped: 0, bytesReclaimed: 0, detail: {} },
        String(error),
      );
    }
  }
  await checkStorageThresholds();
  return results;
}

export async function storageUsage() {
  const rows = await db
    .select({
      type: deploymentArtifacts.type,
      bytes: sql<number>`coalesce(sum(${deploymentArtifacts.sizeBytes}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(deploymentArtifacts)
    .where(isNull(deploymentArtifacts.deletedAt))
    .groupBy(deploymentArtifacts.type);
  const total = rows.reduce((acc, r) => acc + Number(r.bytes), 0);
  const [{ budget }] = await db
    .select({ budget: sql<number>`coalesce(sum(${organizations.storageBudgetBytes}), 0)` })
    .from(organizations);
  const protectedIds = await protectedDeploymentIds();
  const live = await db
    .select({
      id: deploymentArtifacts.id,
      deploymentId: deploymentArtifacts.deploymentId,
      bytes: deploymentArtifacts.sizeBytes,
      expiresAt: deploymentArtifacts.expiresAt,
    })
    .from(deploymentArtifacts)
    .where(isNull(deploymentArtifacts.deletedAt));
  const reclaimable = live.reduce((acc, a) => {
    const isProtected = a.deploymentId ? protectedIds.has(a.deploymentId) : false;
    const expired = a.expiresAt ? new Date(a.expiresAt).getTime() < Date.now() : false;
    return acc + (!isProtected || expired ? Number(a.bytes) : 0);
  }, 0);
  return {
    total,
    budget: Number(budget) || 0,
    byType: rows.map((r) => ({ type: r.type, bytes: Number(r.bytes), count: Number(r.count) })),
    protectedCount: protectedIds.size,
    reclaimableEstimate: reclaimable,
  };
}

async function checkStorageThresholds() {
  const usage = await storageUsage();
  if (!usage.budget) return;
  const ratio = usage.total / usage.budget;
  const thresholds = [0.95, 0.9, 0.8, 0.7];
  const hit = thresholds.find((t) => ratio >= t);
  if (!hit) return;
  const [org] = await db.select().from(organizations).limit(1);
  if (!org) return;
  await db.insert(notifications).values({
    orgId: org.id,
    type: "storage.threshold",
    severity: hit >= 0.9 ? "error" : "warning",
    title: `Storage at ${(ratio * 100).toFixed(0)}% of budget`,
    body: `${(usage.total / 1024 / 1024).toFixed(1)} MB used of ${(usage.budget / 1024 / 1024).toFixed(0)} MB`,
  });
}
