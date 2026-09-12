import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, deploymentEvents, githubWebhookDeliveries } from "@/db/schema";
import { requireProjectAccess } from "@/lib/auth";
import { Empty, Panel, timeAgo } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ActivityPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { project } = await requireProjectAccess(projectId);

  const audits = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.projectId, projectId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(50);
  const events = await db
    .select()
    .from(deploymentEvents)
    .where(eq(deploymentEvents.projectId, projectId))
    .orderBy(desc(deploymentEvents.createdAt))
    .limit(50);
  const deliveries = await db
    .select()
    .from(githubWebhookDeliveries)
    .where(eq(githubWebhookDeliveries.repoFullName, project.repoFullName))
    .orderBy(desc(githubWebhookDeliveries.receivedAt))
    .limit(25);

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Audit log">
        {audits.length === 0 ? (
          <Empty title="No audit entries" />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Action</th>
                <th>Actor</th>
                <th>Resource</th>
                <th>Change</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {audits.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.action}</td>
                  <td style={{ color: "var(--color-fg-secondary)" }}>
                    {a.actorType}:{a.actorId?.slice(0, 8) ?? "system"}
                  </td>
                  <td className="mono" style={{ color: "var(--color-fg-muted)" }}>
                    {a.resourceType}/{a.resourceId?.slice(0, 8) ?? "—"}
                  </td>
                  <td className="mono" style={{ color: "var(--color-fg-muted)" }}>
                    {JSON.stringify(a.newState ?? {}).slice(0, 70)}
                  </td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Deployment events">
          <table className="data">
            <thead>
              <tr>
                <th>Type</th>
                <th>Deployment</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.type}</td>
                  <td className="mono" style={{ color: "var(--color-fg-muted)" }}>
                    {e.deploymentId.slice(0, 8)}
                  </td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="GitHub webhook deliveries">
          {deliveries.length === 0 ? (
            <Empty title="No deliveries received" hint="Add the webhook in the project settings tab." />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Signature</th>
                  <th>Result</th>
                  <th>Received</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.event}</td>
                    <td style={{ color: d.signatureValid ? "var(--color-success)" : "var(--color-danger)" }}>
                      {d.signatureValid ? "valid" : "rejected"}
                      {d.duplicate ? " · duplicate" : ""}
                    </td>
                    <td style={{ color: "var(--color-fg-secondary)" }}>{d.result?.slice(0, 60) ?? "—"}</td>
                    <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(d.receivedAt)}</td>
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
