import { desc, eq } from "drizzle-orm";
import { requirePlatformAdmin, primaryOrg } from "@/lib/auth";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getGarvexProviderStatus } from "@/lib/ai/provider";
import { getSelfPracticeStats } from "@/lib/ai/self-practice";
import { getGarvexCapabilityPlans } from "@/lib/ai/capabilities";
import { freeDomainForProject } from "@/lib/vercel-hosting";
import { GarvexChatV4 } from "@/components/garvex-chat-v4";
import { GarvexFileReader } from "@/components/garvex-file-reader";
import { GarvexCapabilityPanel } from "@/components/garvex-capability-panel";
import { GarvexOrb } from "@/components/garvex-orb";
import { GarvexDefaultAI } from "@/components/garvex-default-ai";
import { GarvexLiveVoice } from "@/components/garvex-live-voice";
import { GarvexUiEnhancer } from "@/components/garvex-ui-enhancer";
import "@/app/garvex-file-reader.css";
import "@/app/garvex-capability-panel.css";
import "@/app/garvex-v4.css";
import "@/app/garvex-overrides.css";
import "@/app/garvex-live-voice.css";

export const dynamic = "force-dynamic";

export default async function GarvexPage() {
  const user = await requirePlatformAdmin();
  const [providers, capabilities, selfPractice] = await Promise.all([
    getGarvexProviderStatus(),
    getGarvexCapabilityPlans(),
    getSelfPracticeStats(),
  ]);
  const membership = await primaryOrg(user.id);
  const rows = membership
    ? await db.select({ id: projects.id, name: projects.name, repoFullName: projects.repoFullName }).from(projects).where(eq(projects.orgId, membership.org.id)).orderBy(desc(projects.updatedAt)).limit(100)
    : [];
  const projectList = await Promise.all(rows.map(async (project) => ({ ...project, liveUrl: `https://${await freeDomainForProject({ ...project } as typeof projects.$inferSelect)}` })));
  const typedProviders = providers.map((provider) => ({ ...provider, state: provider.state as "ready" | "stored-unreadable" | "missing" }));
  return <>
    <GarvexDefaultAI />
    <div className="garvex-v4-chat-stage">
      <GarvexChatV4 csrf={user.csrfToken} providers={typedProviders} projects={projectList} isPlatformAdmin={user.isPlatformAdmin} />
      <div className="garvex-v4-orb-wrap" aria-label="Garvex">
        <GarvexOrb size={180} />
        <span className="garvex-v4-orb-label">GARVEX CORE</span>
      </div>
    </div>
    <GarvexLiveVoice csrf={user.csrfToken} compact />
    <GarvexUiEnhancer />
    <GarvexCapabilityPanel capabilities={capabilities} />
    <section className="garvex-self-practice-panel" aria-label="Verified code-repair examples">
      <strong>Verified code-repair examples collected: {selfPractice.verifiedExamplesTotal}</strong>
      <span>Run scripts/export-training-set.mjs and fine-tune periodically to apply them.</span>
      <div>
        <span>Attempts today: {selfPractice.attemptedToday}/{selfPractice.dailyLimit}</span>
        <span>Pass rate: {selfPractice.passRateToday}%</span>
        <span>Generation: {selfPractice.providerMode}</span>
        <span>Status: {selfPractice.enabled ? "enabled" : "disabled"}</span>
      </div>
    </section>
    <GarvexFileReader csrf={user.csrfToken} />
  </>;
}
