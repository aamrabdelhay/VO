import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments, projects } from "@/db/schema";
import { primaryOrg, requireUser } from "@/lib/auth";
import { Empty, Panel, Status, timeAgo } from "@/components/ui";
import { freeDomainForProject } from "@/lib/vercel-hosting";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const user = await requireUser();
  const membership = await primaryOrg(user.id);
  const rows = membership
    ? await db
        .select()
        .from(projects)
        .where(eq(projects.orgId, membership.org.id))
        .orderBy(desc(projects.updatedAt))
    : [];

  const withLatest = await Promise.all(
    rows.map(async (project) => {
      const [latest] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.projectId, project.id))
        .orderBy(desc(deployments.queuedAt))
        .limit(1);
      return { project, latest };
    }),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold">Projects</h1>
        <Link href="/projects/new" className="btn btn-primary">
          New project
        </Link>
      </div>
      <Panel>
        {withLatest.length === 0 ? (
          <Empty title="No projects" hint="Create a project to connect a GitHub repository." />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th>Production URL</th>
                <th>Repository</th>
                <th>Last deployment</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {withLatest.map(({ project, latest }) => (
                <tr key={project.id}>
                  <td>
                    <Link href={`/projects/${project.id}`} className="font-medium hover:underline">
                      {project.name}
                    </Link>
                  </td>
                  <td className="mono" style={{ color: "var(--color-fg-secondary)" }}>
                    <a href={`https://${freeDomainForProject(project)}`} target="_blank" rel="noreferrer">
                      {freeDomainForProject(project)} ↗
                    </a>
                  </td>
                  <td className="mono" style={{ color: "var(--color-fg-secondary)" }}>
                    {project.repoFullName}
                  </td>
                  <td>{latest ? <Status status={latest.status} /> : "—"}</td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(project.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Panel>
      </div>
    </div>
  );
}