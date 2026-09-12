import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { envVars } from "@/db/schema";
import { requireProjectAccess } from "@/lib/auth";
import { Empty, Panel, timeAgo } from "@/components/ui";
import { ActionButton } from "@/components/client";
import { EnvSmartForm } from "@/components/env-smart-form";

export const dynamic = "force-dynamic";
export default async function EnvPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params; const { project, user } = await requireProjectAccess(projectId); const rows = await db.select().from(envVars).where(eq(envVars.projectId, projectId));
  return <div className="flex flex-col gap-4">
    <div className="flex items-center justify-between gap-2"><div><h2 className="text-[15px] font-semibold">Environment variables</h2><p className="hint mt-1">Production, preview, and development configuration for {project.name}.</p></div><Link className="btn" href={`/projects/${projectId}`}>← Back to project</Link></div>
    <Panel title="Add environment variable"><EnvSmartForm csrf={user.csrfToken} projectId={projectId} /><p className="hint px-3.5 pb-3.5">Search a common variable name and click it, or type a custom key. Values are encrypted at rest, versioned on change, scoped to the selected environment, and never returned in plaintext.</p></Panel>
    <Panel title={`Variables (${rows.length})`}>{rows.length===0?<Empty title="No variables configured" hint="Add DATABASE_URL, API credentials, or any custom project setting above."/>:<table className="data"><thead><tr><th>Key</th><th>Scope</th><th>Value</th><th>Version</th><th>Updated</th><th/></tr></thead><tbody>{rows.map((row)=><tr key={row.id}><td className="mono">{row.key}</td><td style={{color:"var(--color-fg-secondary)"}}>{row.scope.toLowerCase()}</td><td className="mono" style={{color:"var(--color-fg-muted)"}}>••••{row.lastFour}</td><td className="mono">v{row.version}</td><td style={{color:"var(--color-fg-muted)"}}>{timeAgo(row.updatedAt)}</td><td className="text-right"><ActionButton csrf={user.csrfToken} method="DELETE" path={`/api/v1/projects/${projectId}/env?id=${row.id}`} variant="btn-danger" confirm={`Delete ${row.key}?`}>Delete</ActionButton></td></tr>)}</tbody></table>}</Panel>
  </div>;
}
