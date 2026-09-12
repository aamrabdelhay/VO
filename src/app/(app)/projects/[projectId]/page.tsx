import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { containerInstances, deployments, healthCheckResults } from "@/db/schema";
import { requireProjectAccess } from "@/lib/auth";
import { freeDomainForProject, syncVercelDeployment } from "@/lib/vercel-hosting";
import { Empty, KeyValue, Metric, Panel, Status, duration, timeAgo } from "@/components/ui";
import { ActionButton } from "@/components/client";

export const dynamic = "force-dynamic";

export default async function ProjectOverview({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { project, user } = await requireProjectAccess(projectId);

  const recent = await db
    .select()
    .from(deployments)
    .where(eq(deployments.projectId, projectId))
    .orderBy(desc(deployments.queuedAt))
    .limit(8);
  const currentCandidate = recent.find((d) => d.id === project.currentHealthyDeploymentId) ?? null;
  const current = currentCandidate ? await syncVercelDeployment(currentCandidate) : null;
  const [instance] = current
    ? await db
        .select()
        .from(containerInstances)
        .where(
          and(
            eq(containerInstances.deploymentId, current.id),
            eq(containerInstances.status, "running"),
          ),
        )
        .limit(1)
    : [];
  const health = current
    ? await db
        .select()
        .from(healthCheckResults)
        .where(eq(healthCheckResults.deploymentId, current.id))
        .orderBy(desc(healthCheckResults.checkedAt))
        .limit(1)
    : [];

  const rollbackTarget = recent.find(
    (d) => d.id !== project.currentHealthyDeploymentId && d.artifactRef && d.target === "PRODUCTION",
  );
  const liveUrl = current?.url ?? `https://${freeDomainForProject(project)}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Production"
          value={current ? current.commitSha.slice(0, 7) : "none"}
          hint={current ? `promoted ${timeAgo(current.promotedAt)}` : "no healthy deployment"}
        />
        <Metric
          label="Runtime"
          value={instance ? `port ${instance.port}` : "hosted"}
          hint={instance ? `${instance.driver} driver` : "Vercel deployment"}
        />
        <Metric
          label="Last health probe"
          value={health[0] ? (health[0].ok ? "healthy" : "failing") : current?.status === "PROMOTED" ? "healthy" : "—"}
          hint={health[0] ? `${health[0].latencyMs ?? 0}ms` : undefined}
        />
        <Metric
          label="Desired commit"
          value={project.desiredCommitSha?.slice(0, 7) ?? "—"}
          hint={`generation ${project.deploymentGeneration}`}
        />
      </div>

      <Panel
        title="Live project"
        actions={
          <div className="flex flex-wrap gap-2">
            <Link className="btn" href={`/projects/${projectId}/preview`}>
              Preview inside VO
            </Link>
            <a className="btn btn-primary" href={liveUrl} target="_blank" rel="noreferrer">
              Open live project ↗
            </a>
          </div>
        }
      >
        <div className="grid gap-4 p-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <div className="text-sm font-semibold">{project.name}</div>
            <div className="mono mt-1 text-xs" style={{ color: "var(--color-fg-secondary)" }}>
              {liveUrl}
            </div>
            <p className="hint mt-2">
              This URL is assigned to this project only. Future successful deployments move the same free URL to the newest deployment.
            </p>
          </div>
          <div className="rounded border p-3 text-right" style={{ borderColor: "var(--color-border)" }}>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: "var(--color-fg-muted)" }}>
              Domain
            </div>
            <div className="mono mt-1 text-sm">{new URL(liveUrl).hostname}</div>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel
          title="Recent deployments"
          actions={
            <Link className="btn" href={`/projects/${projectId}/deployments`}>
              All deployments
            </Link>
          }
        >
          {recent.length === 0 ? (
            <Empty title="No deployments yet" hint="Use Deploy to build the production branch." />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Commit</th>
                  <th>Branch</th>
                  <th>Target</th>
                  <th>Duration</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/projects/${projectId}/deployments/${d.id}`}>
                        <Status status={d.id === current?.id ? current.status : d.status} />
                      </Link>
                    </td>
                    <td className="mono">{d.commitSha.slice(0, 7)}</td>
                    <td className="mono" style={{ color: "var(--color-fg-secondary)" }}>
                      {d.branch}
                    </td>
                    <td style={{ color: "var(--color-fg-secondary)" }}>{d.target.toLowerCase()}</td>
                    <td className="mono">{duration(d.buildStartedAt, d.finishedAt ?? d.promotedAt)}</td>
                    <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(d.queuedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="State">
            <KeyValue
              items={[
                ["Production URL", <a key="u" className="mono" href={liveUrl} target="_blank" rel="noreferrer">{liveUrl}</a>],
                ["Desired deployment", <span key="d" className="mono">{project.desiredDeploymentId?.slice(0, 8) ?? "—"}</span>],
                ["Current healthy", <span key="c" className="mono">{project.currentHealthyDeploymentId?.slice(0, 8) ?? "—"}</span>],
                ["Last success", <span key="s" className="mono">{project.lastSuccessfulCommitSha?.slice(0, 7) ?? "—"}</span>],
                ["Last failure", <span key="f" className="mono">{project.lastFailedCommitSha?.slice(0, 7) ?? "—"}</span>],
                ["Framework", project.framework ?? "auto-detect"],
                ["Auto rollback", project.autoRollback ? "enabled" : "disabled"],
              ]}
            />
          </Panel>
          <Panel title="Operations">
            <div className="flex flex-wrap gap-2 p-3.5">
              <ActionButton
                csrf={user.csrfToken}
                path={`/api/v1/projects/${projectId}/deployments`}
                body={{ branch: project.productionBranch }}
                variant="btn-primary"
              >
                Deploy latest commit
              </ActionButton>
              {rollbackTarget ? (
                <ActionButton
                  csrf={user.csrfToken}
                  path={`/api/v1/deployments/${rollbackTarget.id}`}
                  body={{ action: "rollback" }}
                  confirm={`Roll back production to ${rollbackTarget.commitSha.slice(0, 7)}?`}
                >
                  Rollback to {rollbackTarget.commitSha.slice(0, 7)}
                </ActionButton>
              ) : null}
              {current ? (
                <ActionButton
                  csrf={user.csrfToken}
                  path={`/api/v1/deployments/${current.id}`}
                  body={{ action: "redeploy" }}
                >
                  Redeploy current commit
                </ActionButton>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}