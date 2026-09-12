import { db } from "@/db";
import { auditLogs, notifications } from "@/db/schema";

export async function audit(entry: {
  orgId?: string | null;
  projectId?: string | null;
  actorId?: string | null;
  actorType?: "user" | "system" | "ai" | "github";
  action: string;
  resourceType: string;
  resourceId?: string | null;
  oldState?: unknown;
  newState?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}) {
  await db.insert(auditLogs).values({
    orgId: entry.orgId ?? null,
    projectId: entry.projectId ?? null,
    actorId: entry.actorId ?? null,
    actorType: entry.actorType ?? "user",
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    oldState: (entry.oldState ?? null) as object | null,
    newState: (entry.newState ?? null) as object | null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
  });
}

export async function notify(entry: {
  orgId: string;
  projectId?: string | null;
  type: string;
  severity?: "info" | "success" | "warning" | "error";
  title: string;
  body?: string;
}) {
  await db.insert(notifications).values({
    orgId: entry.orgId,
    projectId: entry.projectId ?? null,
    type: entry.type,
    severity: entry.severity ?? "info",
    title: entry.title,
    body: entry.body ?? null,
  });
}
