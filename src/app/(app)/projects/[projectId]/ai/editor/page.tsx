import { requireProjectAccess } from "@/lib/auth";
import { resolveAIConfig } from "@/lib/ai/provider";
import { getPlatformSecret } from "@/lib/platform-secrets";
import { Panel, Empty } from "@/components/ui";
import { AIEditor } from "@/components/ai-editor";
import { NvidiaAISetup } from "@/components/nvidia-ai-setup";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AIEditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { project, user } = await requireProjectAccess(projectId, "DEVELOPER");
  const config = await resolveAIConfig(project.orgId);
  const platformNvidiaKey = await getPlatformSecret("NVIDIA_API_KEY");
  const nvidiaConfigured = config?.provider === "nvidia" || Boolean(platformNvidiaKey);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">AI Editor</h2>
          <p className="hint mt-1">Describe a change, let the model inspect the repository, review the proposed files, then publish a branch and pull request.</p>
        </div>
        <Link className="btn" href={`/projects/${projectId}/ai`}>AI overview</Link>
      </div>
      <Panel title="NVIDIA AI (recommended free setup)">
        <NvidiaAISetup csrf={user.csrfToken} projectId={projectId} configured={nvidiaConfigured} />
      </Panel>
      <Panel title="Edit your project with AI">
        <AIEditor csrf={user.csrfToken} projectId={projectId} />
      </Panel>
      <Panel title="Safety boundary">
        <Empty title="Changes are staged through GitHub" hint="The editor works from an exact commit and publishes changes to an isolated branch/PR. It does not write directly to the production branch." />
      </Panel>
    </div>
  );
}
