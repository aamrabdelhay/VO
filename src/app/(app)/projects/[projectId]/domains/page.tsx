import { eq } from "drizzle-orm";
import { db } from "@/db";
import { domains } from "@/db/schema";
import { requireProjectAccess } from "@/lib/auth";
import { dnsInstructions } from "@/lib/domains";
import { platformHost } from "@/lib/router";
import { Empty, Panel, Status, timeAgo } from "@/components/ui";
import { ActionButton, DomainForm } from "@/components/client";

export const dynamic = "force-dynamic";

export default async function DomainsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { project, user } = await requireProjectAccess(projectId);
  const rows = await db.select().from(domains).where(eq(domains.projectId, projectId));

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Platform domain">
        <div className="p-3.5">
          <p className="mono">{platformHost(project.slug)}</p>
          <p className="hint">
            Automatically routed to the current healthy production deployment. Preview deployments
            use pr-&lt;number&gt;.{platformHost(project.slug)}.
          </p>
        </div>
      </Panel>

      <Panel title="Custom domains">
        <DomainForm csrf={user.csrfToken} projectId={projectId} />
        {rows.length === 0 ? (
          <Empty title="No custom domains" hint="Add a domain, then create the DNS records shown." />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Status</th>
                <th>Certificate</th>
                <th>DNS records</th>
                <th>Checked</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const instructions = dnsInstructions(d, project.slug);
                return (
                  <tr key={d.id}>
                    <td className="mono">{d.domain}</td>
                    <td>
                      <Status status={d.status} />
                    </td>
                    <td style={{ color: "var(--color-fg-secondary)" }}>{d.certificateStatus}</td>
                    <td className="mono" style={{ color: "var(--color-fg-muted)" }}>
                      <div>CNAME {instructions.cname.name} → {instructions.cname.value}</div>
                      <div>TXT {instructions.txt.name} → {instructions.txt.value.slice(0, 18)}…</div>
                      {d.lastError ? (
                        <div style={{ color: "var(--color-danger)" }}>{d.lastError}</div>
                      ) : null}
                    </td>
                    <td style={{ color: "var(--color-fg-muted)" }}>{timeAgo(d.lastCheckedAt)}</td>
                    <td className="text-right">
                      <div className="flex justify-end gap-2">
                        <ActionButton
                          csrf={user.csrfToken}
                          path={`/api/v1/projects/${projectId}/domains`}
                          body={{ action: "verify", domainId: d.id }}
                        >
                          Verify
                        </ActionButton>
                        <ActionButton
                          csrf={user.csrfToken}
                          method="DELETE"
                          path={`/api/v1/projects/${projectId}/domains?id=${d.id}`}
                          variant="btn-danger"
                          confirm={`Remove ${d.domain}?`}
                        >
                          Remove
                        </ActionButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
