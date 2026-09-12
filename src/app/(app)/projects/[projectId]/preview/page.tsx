import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments } from "@/db/schema";
import { requireProjectAccess } from "@/lib/auth";
import { freeDomainForProject, syncVercelDeployment } from "@/lib/vercel-hosting";
import { ProjectLiveView } from "@/components/project-live-view";

export const dynamic = "force-dynamic";

export default async function ProjectPreviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { project, user } = await requireProjectAccess(projectId);
  const recent = await db.select().from(deployments).where(and(eq(deployments.projectId, projectId), eq(deployments.target, "PRODUCTION"))).orderBy(desc(deployments.queuedAt)).limit(10);
  const candidate = recent.find((d) => d.id === project.currentHealthyDeploymentId) ?? recent[0] ?? null;
  const deployment = candidate ? await syncVercelDeployment(candidate) : null;
  const liveUrl = deployment?.url ?? `https://${await freeDomainForProject(project)}`;

  return <div className="flex min-h-[calc(100vh-7rem)] flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><Link className="btn" href={`/projects/${projectId}`}>← Back to project</Link><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{project.name} · Live View</div><div className="mono truncate text-[11px] text-muted-foreground">Source → Vercel Preview → rendered website</div></div></div>
    <ProjectLiveView projectId={projectId} csrf={user.csrfToken} initialUrl={liveUrl} />
    <p className="hint">Build Live View creates a real Vercel PREVIEW deployment from the project commit and embeds the returned URL. This is an actual build/runtime result, not a screenshot or static source renderer.</p>
  </div>;
}
