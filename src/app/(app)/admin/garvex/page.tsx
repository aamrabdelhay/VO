import { desc, eq } from "drizzle-orm";
import { requirePlatformAdmin, primaryOrg } from "@/lib/auth";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getGarvexProviderStatus } from "@/lib/ai/provider";
import { getGarvexCapabilityPlans } from "@/lib/ai/capabilities";
import { freeDomainForProject } from "@/lib/vercel-hosting";
import { GarvexChatV4 } from "@/components/garvex-chat-v4";
import { GarvexFileReader } from "@/components/garvex-file-reader";
import { GarvexCapabilityPanel } from "@/components/garvex-capability-panel";
import { GarvexOrb } from "@/components/garvex-orb";
import "@/app/garvex-file-reader.css";
import "@/app/garvex-capability-panel.css";
import "@/app/garvex-v4.css";
import "@/app/garvex-overrides.css";

export const dynamic = "force-dynamic";

export default async function GarvexPage() {
  const user = await requirePlatformAdmin();
  const [providers, capabilities] = await Promise.all([getGarvexProviderStatus(), getGarvexCapabilityPlans()]);
  const membership = await primaryOrg(user.id);
  const rows = membership
    ? await db.select({ id: projects.id, name: projects.name, repoFullName: projects.repoFullName }).from(projects).where(eq(projects.orgId, membership.org.id)).orderBy(desc(projects.updatedAt)).limit(100)
    : [];
  const projectList = await Promise.all(rows.map(async (project) => ({ ...project, liveUrl: `https://${await freeDomainForProject({ ...project } as typeof projects.$inferSelect)}` })));
  const typedProviders = providers.map((provider) => ({ ...provider, state: provider.state as "ready" | "stored-unreadable" | "missing" }));
  return <>
    <div className="garvex-v4-orb-wrap" aria-label="Garvex">
      <GarvexOrb size={180} />
      <span className="garvex-v4-orb-label">GARVEX CORE</span>
    </div>
    <GarvexChatV4 csrf={user.csrfToken} providers={typedProviders} projects={projectList} isPlatformAdmin={user.isPlatformAdmin} />
    <GarvexCapabilityPanel capabilities={capabilities} />
    <GarvexFileReader csrf={user.csrfToken} />
  </>;
}
