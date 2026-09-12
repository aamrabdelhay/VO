import { requireUser } from "@/lib/auth";
import { NewProjectForm } from "@/components/client";
import { Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  const user = await requireUser();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-[15px] font-semibold">New project</h1>
        <p className="hint">
          GitHub remains the source of truth. The platform stores configuration and deployment state
          only; build and start commands are detected automatically when left blank.
        </p>
      </div>
      <Panel title="Repository">
        <div className="p-3.5">
          <NewProjectForm csrf={user.csrfToken} />
        </div>
      </Panel>
      <Panel title="After creation">
        <ol
          className="list-decimal space-y-1.5 px-8 py-3.5"
          style={{ color: "var(--color-fg-secondary)" }}
        >
          <li>Add the webhook shown on the project settings page to the GitHub repository.</li>
          <li>Add environment variables for the production and preview scopes.</li>
          <li>Trigger the first deployment; pushes to the production branch deploy automatically.</li>
        </ol>
      </Panel>
    </div>
  );
}
