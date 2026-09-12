import { requirePlatformAdmin } from "@/lib/auth";
import { listPlatformSecretMetadata } from "@/lib/platform-secrets";
import { Panel, Empty } from "@/components/ui";
import { PlatformSecretsForm } from "@/components/platform-secrets-form";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const user = await requirePlatformAdmin();
  const secrets = await listPlatformSecretMetadata();
  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <div>
        <h1 className="text-[15px] font-semibold">Platform Settings</h1>
        <p className="hint mt-1">Provider credentials used by VO itself. These are separate from project environment variables.</p>
      </div>
      <Panel title="Hosting & API credentials">
        <PlatformSecretsForm csrf={user.csrfToken} initial={secrets} />
      </Panel>
      {secrets.length === 0 ? null : (
        <Panel title="Configured platform credentials">
          <table className="data">
            <thead><tr><th>Key</th><th>Value</th><th>Updated</th></tr></thead>
            <tbody>{secrets.map((secret) => (
              <tr key={secret.key}>
                <td className="mono">{secret.key}</td>
                <td className="mono" style={{ color: "var(--color-fg-muted)" }}>••••{secret.last_four ?? ""}</td>
                <td style={{ color: "var(--color-fg-muted)" }}>{new Date(secret.updated_at).toLocaleString()}</td>
              </tr>
            ))}</tbody>
          </table>
        </Panel>
      )}
      <Empty title="Credentials are encrypted at rest" hint="VO never sends the plaintext value back to the browser after saving." />
    </div>
  );
}
