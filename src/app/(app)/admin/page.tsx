import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLogs,
  cleanupRuns,
  containerInstances,
  deployments,
  hosts,
  incidents,
  jobs,
  projects,
  users,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { storageUsage } from "@/lib/cleanup";
import { Empty, Metric, Panel, Status, bytes, timeAgo } from "@/components/ui";
import { ActionButton } from "@/components/client";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await requireUser();
  if (!user.isPlatformAdmin) {
    return <Empty title="Platform administrator role required" hint="Ask an owner for access." />;
  }

  const [counts] = await db
    .select({
      users: sql<number>`(select count(*) from ${users})`,
      projects: sql<number>`(select count(*) from ${projects})`,
      deployments: sql<number>`(select count(*) from ${deployments})`,
      running: sql<number>`(select count(*) from ${containerInstances} where status = 'running')`,
    })
    .from(sql`(select 1) as t`);
  const queue = await db
    .select({ status: jobs.status, count: sql<number>`count(*)` })
    .from(jobs)
    .groupBy(jobs.status);
  const dead = await db.select().from(jobs).where(eq(jobs.status, "DEAD")).orderBy(desc(jobs.updatedAt)).limit(10);
  const recentJobs = await db.select().from(jobs).orderBy(desc(jobs.updatedAt)).limit(12);
  const hostRows = await db.select().from(hosts);
  const usage = await storageUsage();
  const openIncidents = await db.select().from(incidents).orderBy(desc(incidents.startedAt)).limit(8);
  const audits = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(20);
  const cleanups = await db.select().from(cleanupRuns).orderBy(desc(cleanupRuns.startedAt)).limit(6);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[15px] font-semibold">Administration</h1>
        <div className="flex gap-2">
          <ActionButton csrf={user.csrfToken} path="/api/v1/admin" body={{ action: "reconcile" }}>
            Reconcile now
          </ActionButton>
          <ActionButton csrf={user.csrfToken} path="/api/v1/admin" body={{ action: "drain-queue" }}>
            Drain queue
          </ActionButton>
          <ActionButton csrf={user.csrfToken} path="/api/v1/admin" body={{ action: "cleanup" }}>
            Run cleanup
          </ActionButton>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label="Users" value={Number(counts.users)} />
        <Metric label="Projects" value={Number(counts.projects)} />
        <Metric label="Deployments" value={Number(counts.deployments)} />
        <Metric label="Running runtimes" value={Number(counts.running)} />
        <Metric label="Storage" value={bytes(usage.total)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Queue">
          <table className="data">
            <thead>
              <tr>
                <th>Status</th>
                <th>Jobs</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((q) => (
                <tr key={q.status}>
                  <td>{q.status}</td>
                  <td className="mono">{Number(q.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Hosts">
          <table className="data">
            <thead>
              <tr>
                <th>Host</th>
                <th>Region</th>
                <th>Driver</th>
                <th>Health</th>
                <th>Heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {hostRows.map((h) => (
                <tr key={h.id}>
                  <td className="mono">{h.id}</td>
                  <td>{h.region}</td>
                  <td>{h.driver}</td>
                  <td>
                    <Status status={h.healthy ? "HEALTHY" : "FAILED"} />
                  </td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(h.lastHeartbeatAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Dead-letter jobs">
        {dead.length === 0 ? (
          <Empty title="No dead jobs" />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Type</th>
                <th>Project</th>
                <th>Attempts</th>
                <th>Error</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dead.map((j) => (
                <tr key={j.id}>
                  <td className="mono">{j.type}</td>
                  <td className="mono" style={{ color: "var(--color-fg-muted)" }}>
                    {j.projectId?.slice(0, 8) ?? "—"}
                  </td>
                  <td className="mono">{j.attempts}</td>
                  <td style={{ color: "var(--color-danger)" }}>{j.lastError?.slice(0, 80)}</td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(j.updatedAt)}</td>
                  <td className="text-right">
                    <ActionButton
                      csrf={user.csrfToken}
                      path="/api/v1/admin"
                      body={{ action: "retry-job", jobId: j.id }}
                    >
                      Retry
                    </ActionButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Recent jobs">
          <table className="data">
            <thead>
              <tr>
                <th>Type</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {recentJobs.map((j) => (
                <tr key={j.id}>
                  <td className="mono">{j.type}</td>
                  <td style={{ color: "var(--color-fg-secondary)" }}>{j.status}</td>
                  <td className="mono">{j.attempts}</td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(j.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Incidents">
          {openIncidents.length === 0 ? (
            <Empty title="No incidents recorded" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Severity</th>
                  <th>Title</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {openIncidents.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.kind}</td>
                    <td style={{ color: "var(--color-danger)" }}>{i.severity}</td>
                    <td style={{ color: "var(--color-fg-secondary)" }}>{i.title}</td>
                    <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(i.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Cleanup history">
          <table className="data">
            <thead>
              <tr>
                <th>Task</th>
                <th>Deleted</th>
                <th>Reclaimed</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {cleanups.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.kind}</td>
                  <td className="mono">{c.itemsDeleted}</td>
                  <td className="mono">{bytes(Number(c.bytesReclaimed))}</td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(c.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Audit log">
          <table className="data">
            <thead>
              <tr>
                <th>Action</th>
                <th>Actor</th>
                <th>Resource</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {audits.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.action}</td>
                  <td style={{ color: "var(--color-fg-secondary)" }}>{a.actorType}</td>
                  <td className="mono" style={{ color: "var(--color-fg-muted)" }}>
                    {a.resourceType}
                  </td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
