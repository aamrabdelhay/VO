import { desc, eq } from "drizzle-orm";
import { requirePlatformAdmin, primaryOrg } from "@/lib/auth";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getGarvexProviderStatus } from "@/lib/ai/provider";
import { GarvexConsole } from "@/components/garvex-console";

export const dynamic = "force-dynamic";

export default async function GarvexPage() {
  const user = await requirePlatformAdmin();
  const providers = await getGarvexProviderStatus();
  const membership = await primaryOrg(user.id);
  const projectList = membership
    ? await db.select({ id: projects.id, name: projects.name, repoFullName: projects.repoFullName }).from(projects).where(eq(projects.orgId, membership.org.id)).orderBy(desc(projects.updatedAt)).limit(30)
    : [];
  return <GarvexConsole csrf={user.csrfToken} providers={providers} projects={projectList} isPlatformAdmin={user.isPlatformAdmin} />;
}
