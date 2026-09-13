import { desc, eq } from "drizzle-orm";
import { requirePlatformAdmin, primaryOrg } from "@/lib/auth";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getGarvexProviderStatus } from "@/lib/ai/provider";
import { getGarvexCapabilityPlans } from "@/lib/ai/capabilities";
import { freeDomainForProject } from "@/lib/vercel-hosting";
import { GarvexMaxConsoleV3 } from "@/components/garvex-max-console-v3";
import { GarvexFileReader } from "@/components/garvex-file-reader";
import { GarvexCapabilityPanel } from "@/components/garvex-capability-panel";
import "../../../garvex-file-reader.css";
import "../../garvex-capability-panel.css";

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
  return <><GarvexCapabilityPanel capabilities={capabilities} /><GarvexMaxConsoleV3 csrf={user.csrfToken} providers={typedProviders} projects={projectList} isPlatformAdmin={user.isPlatformAdmin} /><GarvexFileReader csrf={user.csrfToken} /></>;
}
