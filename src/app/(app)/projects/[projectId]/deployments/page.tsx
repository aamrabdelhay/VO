import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments } from "@/db/schema";
import { requireProjectAccess } from "@/lib/auth";
import { Empty, Panel, Status, duration, timeAgo } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DeploymentsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { project } = await requireProjectAccess(projectId);
  const rows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.projectId, projectId))
    .orderBy(desc(deployments.queuedAt))
    .limit(100);

  const production = rows.filter((r) => r.target === "PRODUCTION");
  const previews = rows.filter((r) => r.target === "PREVIEW");

  const table = (list: typeof rows) => (
    <table className="data">
      <thead>
        <tr>
          <th>Status</th>
          <th>Commit</th>
          <th>Branch</th>
          <th>Author</th>
          <th>Trigger</th>
          <th>Duration</th>
          <th>Created</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {list.map((d) => (
          <tr key={d.id}>
            <td>
              <Status status={d.status} />
            </td>
            <td className="mono">
              <Link href={`/projects/${projectId}/deployments/${d.id}`} className="hover:underline">
                {d.commitSha.slice(0, 7)}
              </Link>
              {d.id === project.currentHealthyDeploymentId ? (
                <span className="ml-2" style={{ color: "var(--color-success)", fontSize: 10.5 }}>
                  PRODUCTION
                </span>
              ) : null}
            </td>
            <td className="mono" style={{ color: "var(--color-fg-secondary)" }}>
              {d.branch}
              {d.prNumber ? ` · PR #${d.prNumber}` : ""}
            </td>
            <td style={{ color: "var(--color-fg-secondary)" }}>{d.commitAuthor ?? "—"}</td>
            <td style={{ color: "var(--color-fg-muted)" }}>{d.triggerSource}</td>
            <td className="mono">{duration(d.buildStartedAt, d.finishedAt ?? d.promotedAt)}</td>
            <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(d.queuedAt)}</td>
            <td className="text-right">
              <Link className="btn" href={`/projects/${projectId}/deployments/${d.id}`}>
                Inspect
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="flex flex-col gap-4">
      <Panel title={`Production deployments (${production.length})`}>
        {production.length ? table(production) : <Empty title="No production deployments yet" />}
      </Panel>
      <Panel title={`Preview deployments (${previews.length})`}>
        {previews.length ? (
          table(previews)
        ) : (
          <Empty
            title="No preview deployments"
            hint="Pull requests create previews automatically when previews are enabled."
          />
        )}
      </Panel>
    </div>
  );
}
