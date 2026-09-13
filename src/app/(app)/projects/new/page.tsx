import { requireUser } from "@/lib/auth";
import { GitHubProjectForm } from "@/components/github-project-form";
import { Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  const user = await requireUser();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-[15px] font-semibold">New project</h1>
        <p className="hint">
          Paste the GitHub repository link. VO will register the repository as the source of truth for Garvex inspect, edit, and deployment workflows.
        </p>
      </div>
      <Panel title="Connect GitHub repository">
        <div className="p-3.5">
          <GitHubProjectForm csrf={user.csrfToken} />
        </div>
      </Panel>
      <Panel title="After connection">
        <ol className="list-decimal space-y-1.5 px-8 py-3.5" style={{ color: "var(--color-fg-secondary)" }}>
          <li>VO reads the owner/repository from the GitHub link and stores the project configuration.</li>
          <li>Garvex can inspect the repository and, when you choose Build &amp; Fix, apply requested changes through the connected project workflow.</li>
          <li>Use the project deployment controls to publish the connected repository and verify its production URL.</li>
        </ol>
      </Panel>
    </div>
  );
}
