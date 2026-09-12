import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { containerInstances, deployments, jobs, notifications, projects } from "@/db/schema";
import { requireUser, primaryOrg } from "@/lib/auth";
import { storageUsage } from "@/lib/cleanup";
import { Empty, Metric, Panel, Status, bytes, duration, timeAgo } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();
  const membership = await primaryOrg(user.id);
  if (!membership) return <Empty title="No organization membership" />;

  const orgProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.orgId, membership.org.id))
    .orderBy(desc(projects.updatedAt));
  const projectIds = orgProjects.map((p) => p.id);

  const recent = projectIds.length
    ? await db
        .select()
        .from(deployments)
        .where(sql`${deployments.projectId} in ${projectIds}`)
        .orderBy(desc(deployments.queuedAt))
        .limit(12)
    : [];

  const [{ running }] = await db
    .select({ running: sql<number>`count(*) filter (where status = 'running')` })
    .from(containerInstances);
  const [{ active }] = await db
    .select({
      active: sql<number>`count(*) filter (where status in ('QUEUED','CLONING','BUILDING','TESTING','BUILT','STARTING','HEALTH_CHECKING'))`,
    })
    .from(deployments);
  const [{ queued }] = await db
    .select({ queued: sql<number>`count(*) filter (where status = 'QUEUED')` })
    .from(jobs);
  const usage = await storageUsage();
  const alerts = await db
    .select()
    .from(notifications)
    .where(eq(notifications.orgId, membership.org.id))
    .orderBy(desc(notifications.createdAt))
    .limit(6);

  const failing = orgProjects.filter(
    (p) => p.lastFailedCommitSha && p.lastFailedCommitSha !== p.lastSuccessfulCommitSha,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold">Overview</h1>
        <Link href="/projects/new" className="btn btn-primary">
          New project
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label="Projects" value={orgProjects.length} />
        <Metric label="Running runtimes" value={Number(running)} hint="Data plane containers" />
        <Metric label="Active builds" value={Number(active)} />
        <Metric label="Queued jobs" value={Number(queued)} />
        <Metric label="Storage" value={bytes(usage.total)} hint={`${bytes(usage.reclaimableEstimate)} reclaimable`} />
      </div>

      <Panel title="Projects">
        {orgProjects.length === 0 ? (
          <Empty title="No projects yet" hint="Connect a GitHub repository to deploy it." />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th>Repository</th>
                <th>Branch</th>
                <th>Production commit</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {orgProjects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                  </td>
                  <td className="mono" style={{ color: "var(--color-fg-secondary)" }}>
                    {p.repoFullName}
                  </td>
                  <td className="mono">{p.productionBranch}</td>
                  <td className="mono">{p.lastSuccessfulCommitSha?.slice(0, 7) ?? "—"}</td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Panel title="Recent deployments">
          {recent.length === 0 ? (
            <Empty title="No deployments yet" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Commit</th>
                  <th>Target</th>
                  <th>Duration</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/projects/${d.projectId}/deployments/${d.id}`}>
                        <Status status={d.status} />
                      </Link>
                    </td>
                    <td className="mono">{d.commitSha.slice(0, 7)}</td>
                    <td style={{ color: "var(--color-fg-secondary)" }}>{d.target.toLowerCase()}</td>
                    <td className="mono">{duration(d.buildStartedAt, d.finishedAt ?? d.promotedAt)}</td>
                    <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(d.queuedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Activity">
          {alerts.length === 0 ? (
            <Empty title="No notifications" />
          ) : (
            <ul className="divide-y">
              {alerts.map((n) => (
                <li key={n.id} className="flex gap-2.5 px-3.5 py-2.5">
                  <Status status={n.severity === "error" ? "FAILED" : n.severity === "warning" ? "DRAINING" : "HEALTHY"} />
                  <div className="min-w-0">
                    <div className="truncate">{n.title}</div>
                    <div className="hint truncate">{n.body}</div>
                  </div>
                  <span className="ml-auto hint whitespace-nowrap">{timeAgo(n.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
          {failing.length ? (
            <div className="border-t px-3.5 py-2.5 text-[11.5px]" style={{ color: "var(--color-warning)" }}>
              {failing.length} project(s) have a failing commit newer than the last success.
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}
