import { desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { cleanupRuns, deploymentArtifacts, projects } from "@/db/schema";
import { primaryOrg, requireUser } from "@/lib/auth";
import { storageUsage } from "@/lib/cleanup";
import { Empty, Metric, Panel, bytes, timeAgo } from "@/components/ui";
import { ActionButton } from "@/components/client";

export const dynamic = "force-dynamic";

export default async function StoragePage() {
  const user = await requireUser();
  const membership = await primaryOrg(user.id);
  const usage = await storageUsage();
  const runs = await db
    .select()
    .from(cleanupRuns)
    .orderBy(desc(cleanupRuns.startedAt))
    .limit(12);
  const largest = await db
    .select({
      projectId: deploymentArtifacts.projectId,
      name: projects.name,
      bytes: sql<number>`coalesce(sum(${deploymentArtifacts.sizeBytes}),0)`,
      count: sql<number>`count(*)`,
    })
    .from(deploymentArtifacts)
    .innerJoin(projects, eq(projects.id, deploymentArtifacts.projectId))
    .where(isNull(deploymentArtifacts.deletedAt))
    .groupBy(deploymentArtifacts.projectId, projects.name)
    .orderBy(desc(sql`sum(${deploymentArtifacts.sizeBytes})`))
    .limit(10);

  const ratio = usage.budget ? Math.min(100, Math.round((usage.total / usage.budget) * 100)) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold">Storage lifecycle</h1>
        {user.isPlatformAdmin ? (
          <ActionButton csrf={user.csrfToken} path="/api/v1/admin" body={{ action: "cleanup" }}>
            Run cleanup now
          </ActionButton>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Total used" value={bytes(usage.total)} hint={`${ratio}% of budget`} />
        <Metric label="Budget" value={bytes(usage.budget)} hint={membership?.org.name ?? ""} />
        <Metric label="Reclaimable" value={bytes(usage.reclaimableEstimate)} hint="Unreferenced or expired" />
        <Metric label="Protected objects" value={usage.protectedCount} hint="Live production, rollback, previews" />
      </div>

      <Panel title="Usage by category">
        <table className="data">
          <thead>
            <tr>
              <th>Category</th>
              <th>Objects</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {usage.byType.map((row) => (
              <tr key={row.type}>
                <td>{row.type.toLowerCase()}</td>
                <td className="mono">{row.count}</td>
                <td className="mono">{bytes(row.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Largest projects">
          {largest.length === 0 ? (
            <Empty title="No artifacts stored" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Objects</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {largest.map((row) => (
                  <tr key={row.projectId}>
                    <td>{row.name}</td>
                    <td className="mono">{Number(row.count)}</td>
                    <td className="mono">{bytes(Number(row.bytes))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Cleanup runs">
          {runs.length === 0 ? (
            <Empty title="No cleanup runs yet" hint="Garbage collection runs every 30 minutes." />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Deleted</th>
                  <th>Skipped</th>
                  <th>Reclaimed</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.kind}</td>
                    <td className="mono">{r.itemsDeleted}</td>
                    <td className="mono">{r.itemsSkipped}</td>
                    <td className="mono">{bytes(Number(r.bytesReclaimed))}</td>
                    <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(r.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
