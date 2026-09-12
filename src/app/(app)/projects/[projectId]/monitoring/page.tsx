import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { containerInstances, deployments, healthCheckResults, resourceMetrics } from "@/db/schema";
import { requireProjectAccess } from "@/lib/auth";
import { Empty, Metric, Panel, Status, timeAgo } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function MonitoringPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const metrics = await db
    .select()
    .from(resourceMetrics)
    .where(eq(resourceMetrics.projectId, projectId))
    .orderBy(desc(resourceMetrics.recordedAt))
    .limit(60);
  const probes = await db
    .select()
    .from(healthCheckResults)
    .where(eq(healthCheckResults.projectId, projectId))
    .orderBy(desc(healthCheckResults.checkedAt))
    .limit(25);
  const runtimes = await db
    .select()
    .from(containerInstances)
    .where(eq(containerInstances.projectId, projectId))
    .orderBy(desc(containerInstances.startedAt))
    .limit(10);
  const [durations] = await db
    .select({
      avgBuild: sql<number>`coalesce(avg(extract(epoch from (build_ended_at - build_started_at))), 0)`,
      failures: sql<number>`count(*) filter (where status = 'FAILED')`,
      total: sql<number>`count(*)`,
    })
    .from(deployments)
    .where(eq(deployments.projectId, projectId));

  const okRate = probes.length
    ? Math.round((probes.filter((p) => p.ok).length / probes.length) * 100)
    : 100;
  const latest = metrics[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Health success rate" value={`${okRate}%`} hint={`${probes.length} recent probes`} />
        <Metric
          label="CPU"
          value={latest?.cpuPercent != null ? `${latest.cpuPercent.toFixed(1)}%` : "—"}
          hint="latest sample"
        />
        <Metric
          label="Memory"
          value={latest?.memoryMb != null ? `${latest.memoryMb.toFixed(0)} MB` : "—"}
          hint="latest sample"
        />
        <Metric
          label="Avg build time"
          value={`${Number(durations?.avgBuild ?? 0).toFixed(1)}s`}
          hint={`${Number(durations?.failures ?? 0)}/${Number(durations?.total ?? 0)} failed`}
        />
      </div>

      <Panel title="Resource samples">
        {metrics.length === 0 ? (
          <Empty
            title="No samples yet"
            hint="Roll-ups are collected every minute for running runtimes. High-frequency series belong in Prometheus."
          />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Recorded</th>
                <th>Deployment</th>
                <th>CPU %</th>
                <th>Memory MB</th>
              </tr>
            </thead>
            <tbody>
              {metrics.slice(0, 20).map((m) => (
                <tr key={m.id}>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(m.recordedAt)}</td>
                  <td className="mono">{m.deploymentId?.slice(0, 8) ?? "—"}</td>
                  <td className="mono">{m.cpuPercent?.toFixed(1) ?? "—"}</td>
                  <td className="mono">{m.memoryMb?.toFixed(0) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Health checks">
          {probes.length === 0 ? (
            <Empty title="No probes recorded" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Result</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Latency</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {probes.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Status status={p.ok ? "HEALTHY" : "FAILED"} />
                    </td>
                    <td>{p.kind}</td>
                    <td className="mono">{p.statusCode ?? p.error?.slice(0, 24) ?? "—"}</td>
                    <td className="mono">{p.latencyMs ?? 0}ms</td>
                    <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(p.checkedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Runtime instances">
          {runtimes.length === 0 ? (
            <Empty title="No runtimes" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Deployment</th>
                  <th>Driver</th>
                  <th>Port</th>
                  <th>Status</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {runtimes.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.deploymentId.slice(0, 8)}</td>
                    <td>{r.driver}</td>
                    <td className="mono">{r.port}</td>
                    <td>
                      <Status status={r.status === "running" ? "HEALTHY" : "STOPPED"} />
                    </td>
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
