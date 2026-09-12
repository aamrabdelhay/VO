import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments } from "@/db/schema";
import { HttpError, requireProjectAccess } from "@/lib/auth";
import { platformHost } from "@/lib/router";
import { Status } from "@/components/ui";
import { ActionButton } from "@/components/client";

export const dynamic = "force-dynamic";

const TABS = [
  { segment: "", label: "Overview" },
  { segment: "deployments", label: "Deployments" },
  { segment: "env", label: "Environment" },
  { segment: "domains", label: "Domains" },
  { segment: "monitoring", label: "Monitoring" },
  { segment: "ai", label: "AI" },
  { segment: "ai/editor", label: "AI Editor" },
  { segment: "activity", label: "Activity" },
  { segment: "settings", label: "Settings" },
];

export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  let access;
  try { access = await requireProjectAccess(projectId); }
  catch (error) { if (error instanceof HttpError && error.status === 404) notFound(); throw error; }
  const { project, user } = access;
  const current = project.currentHealthyDeploymentId
    ? (await db.select().from(deployments).where(eq(deployments.id, project.currentHealthyDeploymentId)).limit(1))[0]
    : null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[15px] font-semibold">{project.name}</h1>
            {current ? <Status status={current.status} /> : <Status status="QUEUED" />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]" style={{ color: "var(--color-fg-muted)" }}>
            <span className="mono">{project.repoFullName}</span>
            <span className="mono">branch {project.productionBranch}</span>
            <span className="mono">{platformHost(project.slug)}</span>
            {current ? <span className="mono">commit {current.commitSha.slice(0, 7)}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a className="btn" href={`/edge/${project.slug}/`} target="_blank" rel="noreferrer">Open app</a>
          <ActionButton csrf={user.csrfToken} path={`/api/v1/projects/${project.id}/deployments`} body={{ branch: project.productionBranch }} variant="btn-primary">Deploy</ActionButton>
        </div>
      </header>
      <nav className="flex overflow-x-auto border-b" aria-label="Project sections">
        {TABS.map((tab) => (
          <Link key={tab.segment} className="tab whitespace-nowrap" href={`/projects/${projectId}${tab.segment ? `/${tab.segment}` : ""}`}>{tab.label}</Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
