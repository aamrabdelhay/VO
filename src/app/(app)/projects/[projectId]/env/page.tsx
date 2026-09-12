import { eq } from "drizzle-orm";
import { db } from "@/db";
import { envVars } from "@/db/schema";
import { requireProjectAccess } from "@/lib/auth";
import { Empty, Panel, timeAgo } from "@/components/ui";
import { ActionButton, EnvVarForm } from "@/components/client";

export const dynamic = "force-dynamic";

export default async function EnvPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { user } = await requireProjectAccess(projectId);
  const rows = await db.select().from(envVars).where(eq(envVars.projectId, projectId));

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Add environment variable">
        <EnvVarForm csrf={user.csrfToken} projectId={projectId} />
        <p className="hint px-3.5 pb-3.5">
          Values are encrypted at rest with envelope encryption, versioned on every change, injected
          only into the matching runtime scope, and redacted from logs and AI prompts. Plaintext is
          never returned by the API.
        </p>
      </Panel>
      <Panel title={`Variables (${rows.length})`}>
        {rows.length === 0 ? (
          <Empty title="No variables configured" />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Key</th>
                <th>Scope</th>
                <th>Value</th>
                <th>Version</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.key}</td>
                  <td style={{ color: "var(--color-fg-secondary)" }}>{row.scope.toLowerCase()}</td>
                  <td className="mono" style={{ color: "var(--color-fg-muted)" }}>
                    ••••{row.lastFour}
                  </td>
                  <td className="mono">v{row.version}</td>
                  <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(row.updatedAt)}</td>
                  <td className="text-right">
                    <ActionButton
                      csrf={user.csrfToken}
                      method="DELETE"
                      path={`/api/v1/projects/${projectId}/env?id=${row.id}`}
                      variant="btn-danger"
                      confirm={`Delete ${row.key}?`}
                    >
                      Delete
                    </ActionButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
