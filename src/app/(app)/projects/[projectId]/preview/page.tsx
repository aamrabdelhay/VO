import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments } from "@/db/schema";
import { requireProjectAccess } from "@/lib/auth";
import { freeDomainForProject, syncVercelDeployment } from "@/lib/vercel-hosting";

export const dynamic = "force-dynamic";

export default async function ProjectPreviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { project } = await requireProjectAccess(projectId);
  const recent = await db
    .select()
    .from(deployments)
    .where(eq(deployments.projectId, projectId))
    .orderBy(desc(deployments.queuedAt))
    .limit(10);
  const candidate = recent.find((d) => d.id === project.currentHealthyDeploymentId) ?? recent[0] ?? null;
  const deployment = candidate ? await syncVercelDeployment(candidate) : null;
  const liveUrl = deployment?.url ?? `https://${freeDomainForProject(project)}`;

  return (
    <div className="flex min-h-[calc(100vh-7rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link className="btn" href={`/projects/${projectId}`}>
          ← Back to project
        </Link>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{project.name} · Live preview</div>
          <div className="mono truncate text-[11px]" style={{ color: "var(--color-fg-muted)" }}>
            {liveUrl}
          </div>
        </div>
        <a className="btn btn-primary" href={liveUrl} target="_blank" rel="noreferrer">
          Open in new tab ↗
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-white" style={{ borderColor: "var(--color-border)" }}>
        <iframe
          title={`${project.name} live preview`}
          src={liveUrl}
          className="h-[calc(100vh-12rem)] min-h-[600px] w-full bg-white"
          loading="eager"
        />
      </div>

      <p className="hint">
        Some applications block embedding with their own security headers. The "Open in new tab" action remains available in that case.
      </p>
    </div>
  );
}
