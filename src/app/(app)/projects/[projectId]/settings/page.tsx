import { requireProjectAccess } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { Panel } from "@/components/ui";
import { ActionButton, SettingsForm } from "@/components/client";
import { freeDomainForProject } from "@/lib/vercel-hosting";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { project, user } = await requireProjectAccess(projectId);
  const webhookSecret = project.webhookSecretCipher ? decryptSecret(project.webhookSecretCipher) : null;
  const webhookUrl = `${process.env.PLATFORM_PUBLIC_URL ?? ""}/api/v1/webhooks/github`;
  const freeDomain = freeDomainForProject(project);

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Live deployment domain">
        <div className="space-y-2 p-3.5">
          <div>
            <span className="label">Free domain</span>
            <a className="mono" href={`https://${freeDomain}`} target="_blank" rel="noreferrer">
              https://{freeDomain}
            </a>
          </div>
          <p className="hint">
            This is the project's stable free production URL. It is reassigned to the newest successful deployment, so the address does not change on every deploy.
          </p>
        </div>
      </Panel>

      <Panel title="GitHub webhook">
        <div className="space-y-2 p-3.5">
          <div>
            <span className="label">Payload URL</span>
            <code className="mono">{webhookUrl || "/api/v1/webhooks/github"}</code>
          </div>
          <div>
            <span className="label">Content type</span>
            <code className="mono">application/json</code>
          </div>
          <div>
            <span className="label">Secret</span>
            <code className="mono">{webhookSecret ?? "not generated"}</code>
          </div>
          <p className="hint">
            Subscribe to push and pull_request events. Deliveries are signature-verified and deduplicated by X-GitHub-Delivery, so retries never create duplicate deployments.
          </p>
        </div>
      </Panel>

      <Panel title="Build configuration">
        <SettingsForm
          csrf={user.csrfToken}
          projectId={projectId}
          values={{
            name: project.name,
            productionBranch: project.productionBranch,
            rootDirectory: project.rootDirectory,
            installCommand: project.installCommand ?? "",
            buildCommand: project.buildCommand ?? "",
            startCommand: project.startCommand ?? "",
            testCommand: project.testCommand ?? "",
            outputDirectory: project.outputDirectory ?? "",
            nodeVersion: project.nodeVersion,
          }}
          fields={[
            { key: "name", label: "Project name" },
            { key: "productionBranch", label: "Production branch" },
            { key: "rootDirectory", label: "Root directory" },
            { key: "installCommand", label: "Install command", hint: "Blank = detected" },
            { key: "buildCommand", label: "Build command", hint: "Blank = detected" },
            { key: "startCommand", label: "Start command", hint: "Blank = detected" },
            { key: "testCommand", label: "Test command", hint: "Runs before packaging when set" },
            { key: "outputDirectory", label: "Output directory" },
            { key: "nodeVersion", label: "Node version" },
          ]}
        />
      </Panel>

      <Panel title="Runtime, health and rollback">
        <SettingsForm
          csrf={user.csrfToken}
          projectId={projectId}
          values={{
            healthPath: project.healthPath,
            healthExpectedStatus: project.healthExpectedStatus,
            healthTimeoutMs: project.healthTimeoutMs,
            healthRetries: project.healthRetries,
            postPromotionWindowMs: project.postPromotionWindowMs,
            autoRollback: project.autoRollback,
            memoryLimitMb: project.memoryLimitMb,
            cpuLimit: project.cpuLimit,
            previewsEnabled: project.previewsEnabled,
            enabled: project.enabled,
          }}
          fields={[
            { key: "healthPath", label: "Health check path" },
            { key: "healthExpectedStatus", label: "Expected status", type: "number" },
            { key: "healthTimeoutMs", label: "Probe timeout (ms)", type: "number" },
            { key: "healthRetries", label: "Readiness retries", type: "number" },
            { key: "postPromotionWindowMs", label: "Post-promotion window (ms)", type: "number" },
            { key: "autoRollback", label: "Automatic rollback", type: "boolean" },
            { key: "memoryLimitMb", label: "Memory limit (MB)", type: "number" },
            { key: "cpuLimit", label: "CPU limit (cores)", type: "number" },
            { key: "previewsEnabled", label: "Preview deployments", type: "boolean" },
            { key: "enabled", label: "Project enabled", type: "boolean" },
          ]}
        />
      </Panel>

      <Panel title="Retention policy">
        <SettingsForm
          csrf={user.csrfToken}
          projectId={projectId}
          values={{
            retainProductionDeployments: project.retainProductionDeployments,
            previewRetentionDays: project.previewRetentionDays,
            cacheRetentionDays: project.cacheRetentionDays,
            logRetentionDays: project.logRetentionDays,
          }}
          fields={[
            { key: "retainProductionDeployments", label: "Production deployments retained", type: "number" },
            { key: "previewRetentionDays", label: "Preview retention (days)", type: "number" },
            { key: "cacheRetentionDays", label: "Build cache retention (days)", type: "number" },
            { key: "logRetentionDays", label: "Log retention (days)", type: "number" },
          ]}
        />
      </Panel>

      <Panel title="Danger zone">
        <div className="flex items-center justify-between gap-4 p-3.5">
          <p className="hint">
            Deleting the project stops every runtime it owns and removes platform state. The GitHub repository is untouched.
          </p>
          <ActionButton
            csrf={user.csrfToken}
            method="DELETE"
            path={`/api/v1/projects/${projectId}`}
            variant="btn-danger"
            confirm={`Delete ${project.name}? This stops all runtimes.`}
          >
            Delete project
          </ActionButton>
        </div>
      </Panel>
    </div>
  );
}