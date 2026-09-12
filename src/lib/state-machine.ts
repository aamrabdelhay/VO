import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deploymentEvents, deployments } from "@/db/schema";
import { log } from "@/lib/logger";

export type DeploymentStatus =
  | "QUEUED"
  | "CLONING"
  | "BUILDING"
  | "TESTING"
  | "BUILT"
  | "STARTING"
  | "HEALTH_CHECKING"
  | "HEALTHY"
  | "PROMOTING"
  | "PROMOTED"
  | "DRAINING"
  | "STOPPED"
  | "FAILED"
  | "CANCELED"
  | "OBSOLETE"
  | "ROLLED_BACK";

const TERMINAL: DeploymentStatus[] = ["FAILED", "CANCELED", "OBSOLETE", "STOPPED", "ROLLED_BACK"];

/** Single source of truth for legal deployment transitions. */
export const TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  QUEUED: ["CLONING", "CANCELED", "OBSOLETE", "FAILED"],
  CLONING: ["BUILDING", "FAILED", "CANCELED", "OBSOLETE"],
  BUILDING: ["TESTING", "BUILT", "FAILED", "CANCELED", "OBSOLETE"],
  TESTING: ["BUILT", "FAILED", "CANCELED", "OBSOLETE"],
  BUILT: ["STARTING", "FAILED", "CANCELED", "OBSOLETE"],
  STARTING: ["HEALTH_CHECKING", "FAILED", "CANCELED", "OBSOLETE"],
  HEALTH_CHECKING: ["HEALTHY", "FAILED", "CANCELED", "OBSOLETE"],
  HEALTHY: ["PROMOTING", "STOPPED", "OBSOLETE", "FAILED", "DRAINING"],
  PROMOTING: ["PROMOTED", "FAILED", "OBSOLETE"],
  PROMOTED: ["DRAINING", "ROLLED_BACK", "FAILED", "STOPPED"],
  DRAINING: ["STOPPED", "FAILED"],
  STOPPED: ["STARTING"],
  FAILED: [],
  CANCELED: [],
  OBSOLETE: [],
  ROLLED_BACK: ["STARTING", "STOPPED"],
};

export function canTransition(from: DeploymentStatus, to: DeploymentStatus) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: DeploymentStatus) {
  return TERMINAL.includes(status);
}

export class InvalidTransitionError extends Error {
  constructor(from: DeploymentStatus, to: DeploymentStatus) {
    super(`Invalid deployment transition ${from} -> ${to}`);
  }
}

export async function recordEvent(
  deploymentId: string,
  projectId: string,
  type: string,
  message?: string,
  data?: unknown,
  correlationId?: string | null,
) {
  await db.insert(deploymentEvents).values({
    deploymentId,
    projectId,
    type,
    message: message ?? null,
    data: (data ?? null) as object | null,
    correlationId: correlationId ?? null,
  });
}

/**
 * Applies a state transition atomically. Returns null when the transition is
 * illegal or the deployment already moved on (lost race), so callers can stop.
 */
export async function transition(
  deploymentId: string,
  to: DeploymentStatus,
  patch: Partial<typeof deployments.$inferInsert> = {},
  opts: { event?: string; message?: string; data?: unknown } = {},
) {
  const [current] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!current) return null;
  const from = current.status as DeploymentStatus;
  if (from === to) return current;
  if (!canTransition(from, to)) {
    log.warn("Rejected invalid deployment transition", {
      deploymentId,
      projectId: current.projectId,
      from,
      to,
    });
    return null;
  }
  const [updated] = await db
    .update(deployments)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(eq(deployments.id, deploymentId))
    .returning();

  await recordEvent(
    deploymentId,
    current.projectId,
    opts.event ?? `STATE_${to}`,
    opts.message ?? `${from} -> ${to}`,
    opts.data,
    current.correlationId,
  );
  return updated;
}
