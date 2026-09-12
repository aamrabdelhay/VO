import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments } from "@/db/schema";
import { requireProjectAccess } from "@/lib/auth";
import { projectAiActivity } from "@/lib/ai/agent";
import { recentToolCalls, TOOLS } from "@/lib/ai/gateway";
import { resolveAIConfig, spentTodayCents } from "@/lib/ai/provider";
import { Empty, Metric, Panel, Status, timeAgo } from "@/components/ui";
import { ActionButton, AIConfigForm, SettingsForm } from "@/components/client";

export const dynamic = "force-dynamic";

export default async function AiPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { project, user } = await requireProjectAccess(projectId);
  const { actions, fixes } = await projectAiActivity(projectId);
  const toolCalls = await recentToolCalls(projectId, 20);
  const config = await resolveAIConfig(project.orgId);
  const spent = await spentTodayCents(project.orgId);
  const [lastFailed] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.projectId, projectId))
    .orderBy(desc(deployments.queuedAt))
    .limit(1);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Permission" value={project.aiPermission} hint="Server-enforced for every tool" />
        <Metric label="Provider" value={config?.provider ?? "not configured"} hint={config?.model ?? "BYOK required"} />
        <Metric label="Spend today" value={`${spent.toFixed(2)}¢`} hint={`budget ${config?.dailyBudgetCents ?? 0}¢`} />
        <Metric label="Max fix attempts" value={project.aiMaxFixAttempts} hint="Bounded repair loop" />
      </div>

      <Panel
        title="Engineering actions"
        actions={
          lastFailed ? (
            <div className="flex gap-2">
              <ActionButton
                csrf={user.csrfToken}
                path={`/api/v1/projects/${projectId}/ai`}
                body={{ action: "diagnose", deploymentId: lastFailed.id }}
              >
                Diagnose last deployment
              </ActionButton>
              <ActionButton
                csrf={user.csrfToken}
                path={`/api/v1/projects/${projectId}/ai`}
                body={{ action: "fix", deploymentId: lastFailed.id }}
                variant="btn-primary"
              >
                Run bounded fix loop
              </ActionButton>
            </div>
          ) : null
        }
      >
        {actions.length === 0 ? (
          <Empty
            title="No AI activity"
            hint="Diagnosis runs automatically on failed deployments when enabled."
          />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Status</th>
                <th>Summary</th>
                <th>Model</th>
                <th>Cost</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.kind}</td>
                  <td>
                    <Status status={a.status === "succeeded" ? "HEALTHY" : a.status === "failed" ? "FAILED" : "BUILDING"} />
                  </td>
                  <td style={{ color: "var(--color-fg-secondary)" }}>{a.summary?.slice(0, 120) ?? "—"}</td>
                  <td className="mono" style={{ color: "var(--color-fg-muted)" }}>
                    {a.model ?? "—"}
                  </td>
                  <td className="mono">{a.costCents.toFixed(2)}¢</td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Fix attempts">
          {fixes.length === 0 ? (
            <Empty title="No fix attempts" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Attempt</th>
                  <th>Outcome</th>
                  <th>Tests</th>
                  <th>Build</th>
                  <th>Branch</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {fixes.map((f) => (
                  <tr key={f.id}>
                    <td className="mono">#{f.attempt}</td>
                    <td style={{ color: "var(--color-fg-secondary)" }}>{f.outcome}</td>
                    <td>{f.testsPassed === null ? "—" : f.testsPassed ? "pass" : "fail"}</td>
                    <td>{f.buildPassed === null ? "—" : f.buildPassed ? "pass" : "fail"}</td>
                    <td className="mono" style={{ color: "var(--color-fg-muted)" }}>
                      {f.branch ?? "—"}
                    </td>
                    <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(f.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Tool gateway calls">
          {toolCalls.length === 0 ? (
            <Empty title="No tool calls" hint="Every AI capability is mediated and audited here." />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Allowed</th>
                  <th>Duration</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {toolCalls.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">{t.tool}</td>
                    <td style={{ color: t.allowed ? "var(--color-success)" : "var(--color-danger)" }}>
                      {t.allowed ? "allowed" : `denied: ${t.denyReason?.slice(0, 40)}`}
                    </td>
                    <td className="mono">{t.durationMs ?? 0}ms</td>
                    <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Policy">
          <SettingsForm
            csrf={user.csrfToken}
            projectId={projectId}
            values={{
              aiPermission: project.aiPermission,
              aiAutoDiagnose: project.aiAutoDiagnose,
              aiMaxFixAttempts: project.aiMaxFixAttempts,
            }}
            fields={[
              {
                key: "aiPermission",
                label: "Permission level",
                type: "select",
                options: ["READ_ONLY", "DEVELOPER", "AUTO_FIX", "AUTO_DEPLOY"],
                hint: "Unrestricted access is intentionally not offered.",
              },
              { key: "aiAutoDiagnose", label: "Auto-diagnose failures", type: "boolean" },
              { key: "aiMaxFixAttempts", label: "Max fix attempts", type: "number" },
            ]}
          />
        </Panel>
        <Panel title="Provider (BYOK)">
          <AIConfigForm
            csrf={user.csrfToken}
            projectId={projectId}
            provider={config?.provider ?? null}
            model={config?.model ?? null}
          />
        </Panel>
      </div>

      <Panel title="Available tools">
        <table className="data">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Minimum permission</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(TOOLS).map(([name, spec]) => (
              <tr key={name}>
                <td className="mono">{name}</td>
                <td style={{ color: "var(--color-fg-secondary)" }}>{spec.min}</td>
                <td style={{ color: "var(--color-fg-muted)" }}>{spec.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
