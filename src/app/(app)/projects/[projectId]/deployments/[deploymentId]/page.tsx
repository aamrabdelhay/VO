import { notFound } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  containerInstances,
  deploymentArtifacts,
  deploymentEvents,
  deployments,
  healthCheckResults,
} from "@/db/schema";
import { requireProjectAccess } from "@/lib/auth";
import { KeyValue, Panel, Status, bytes, duration, timeAgo } from "@/components/ui";
import { ActionButton, LogStream } from "@/components/client";

export const dynamic = "force-dynamic";

const LIVE = ["QUEUED", "CLONING", "BUILDING", "TESTING", "BUILT", "STARTING", "HEALTH_CHECKING"];

export default async function DeploymentDetail({
  params,
}: {
  params: Promise<{ projectId: string; deploymentId: string }>;
}) {
  const { projectId, deploymentId } = await params;
  const { project, user } = await requireProjectAccess(projectId);
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.projectId, projectId)))
    .limit(1);
  if (!deployment) notFound();

  const events = await db
    .select()
    .from(deploymentEvents)
    .where(eq(deploymentEvents.deploymentId, deploymentId))
    .orderBy(asc(deploymentEvents.createdAt));
  const probes = await db
    .select()
    .from(healthCheckResults)
    .where(eq(healthCheckResults.deploymentId, deploymentId))
    .orderBy(desc(healthCheckResults.checkedAt))
    .limit(10);
  const artifacts = await db
    .select()
    .from(deploymentArtifacts)
    .where(eq(deploymentArtifacts.deploymentId, deploymentId));
  const [instance] = await db
    .select()
    .from(containerInstances)
    .where(
      and(eq(containerInstances.deploymentId, deploymentId), eq(containerInstances.status, "running")),
    )
    .limit(1);

  const isProduction = project.currentHealthyDeploymentId === deploymentId;

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={`Deployment #${deployment.number}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {LIVE.includes(deployment.status) ? (
              <ActionButton
                csrf={user.csrfToken}
                path={`/api/v1/deployments/${deploymentId}`}
                body={{ action: "cancel" }}
              >
                Cancel
              </ActionButton>
            ) : null}
            {deployment.status === "HEALTHY" ? (
              <ActionButton
                csrf={user.csrfToken}
                path={`/api/v1/deployments/${deploymentId}`}
                body={{ action: "promote" }}
                variant="btn-primary"
              >
                Promote
              </ActionButton>
            ) : null}
            {!isProduction && deployment.artifactRef && deployment.target === "PRODUCTION" ? (
              <ActionButton
                csrf={user.csrfToken}
                path={`/api/v1/deployments/${deploymentId}`}
                body={{ action: "rollback" }}
                confirm={`Make ${deployment.commitSha.slice(0, 7)} the live production deployment?`}
              >
                Rollback here
              </ActionButton>
            ) : null}
            <ActionButton
              csrf={user.csrfToken}
              path={`/api/v1/deployments/${deploymentId}`}
              body={{ action: "redeploy" }}
            >
              Redeploy
            </ActionButton>
            {!isProduction && instance ? (
              <ActionButton
                csrf={user.csrfToken}
                path={`/api/v1/deployments/${deploymentId}`}
                body={{ action: "stop" }}
                variant="btn-danger"
              >
                Stop runtime
              </ActionButton>
            ) : null}
          </div>
        }
      >
        <div className="grid gap-0 md:grid-cols-2">
          <KeyValue
            items={[
              ["Status", <Status key="s" status={deployment.status} />],
              ["Target", deployment.target.toLowerCase()],
              ["Commit", <span key="c" className="mono">{deployment.commitSha}</span>],
              ["Message", deployment.commitMessage?.split("\n")[0] ?? "—"],
              ["Author", deployment.commitAuthor ?? "—"],
              ["Branch", <span key="b" className="mono">{deployment.branch}</span>],
            ]}
          />
          <KeyValue
            items={[
              ["Generation", String(deployment.generation)],
              ["Trigger", deployment.triggerSource],
              ["Build duration", duration(deployment.buildStartedAt, deployment.buildEndedAt)],
              ["Runtime", instance ? `${instance.driver} · port ${instance.port}` : "not running"],
              ["Artifact", <span key="a" className="mono">{deployment.artifactRef ?? "released"}</span>],
              ["URL", deployment.url ?? "—"],
              ...(deployment.errorReason
                ? ([["Failure", <span key="e" style={{ color: "var(--color-danger)" }}>{deployment.errorReason}</span>]] as [string, React.ReactNode][])
                : []),
            ]}
          />
        </div>
      </Panel>

      <Panel title="Build and runtime logs">
        <LogStream deploymentId={deploymentId} live={LIVE.includes(deployment.status)} />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Events">
          <table className="data">
            <thead>
              <tr>
                <th>Event</th>
                <th>Detail</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.type}</td>
                  <td style={{ color: "var(--color-fg-secondary)" }}>{e.message}</td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Health probes">
            <table className="data">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Result</th>
                  <th>Latency</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {probes.map((p) => (
                  <tr key={p.id}>
                    <td>{p.kind}</td>
                    <td>
                      <Status status={p.ok ? "HEALTHY" : "FAILED"} />
                    </td>
                    <td className="mono">{p.latencyMs ?? 0}ms</td>
                    <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(p.checkedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Artifacts">
            <table className="data">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Key</th>
                  <th>Size</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.type}</td>
                    <td className="mono" style={{ color: "var(--color-fg-secondary)" }}>
                      {a.storageKey}
                    </td>
                    <td className="mono">{bytes(Number(a.sizeBytes))}</td>
                    <td style={{ color: "var(--color-fg-muted)" }}>
                      {a.deletedAt ? "deleted" : a.expiresAt ? timeAgo(a.expiresAt) : "retained"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  );
}
