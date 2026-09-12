import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments, domains, envVars, projects } from "@/db/schema";
import { transition, recordEvent } from "@/lib/state-machine";
import { decryptSecret } from "@/lib/crypto";
import { getPlatformSecret } from "@/lib/platform-secrets";

type Project = typeof projects.$inferSelect;
type Deployment = typeof deployments.$inferSelect;
const API = "https://api.vercel.com";

async function token() { return process.env.VERCEL_DEPLOY_TOKEN || process.env.VERCEL_TOKEN || (await getPlatformSecret("VERCEL_DEPLOY_TOKEN")) || ""; }
async function teamQuery() { const teamId = process.env.VERCEL_DEPLOY_TEAM_ID || process.env.VERCEL_TEAM_ID || (await getPlatformSecret("VERCEL_DEPLOY_TEAM_ID")); return teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""; }
async function vercelRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = await token();
  if (!auth) throw new Error("Vercel deployment provider is not configured. Add a Vercel Deploy Token in VO → Settings.");
  const response = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", ...(init.headers ?? {}) }, cache: "no-store" });
  const text = await response.text(); let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: { message: text || `Vercel request failed (${response.status})` } }; }
  if (!response.ok) {
    const message = typeof data === "object" && data && "error" in data ? String((data as { error?: { message?: unknown } }).error?.message ?? `HTTP ${response.status}`) : `HTTP ${response.status}`;
    throw new Error(`Vercel API ${response.status}: ${message}`);
  }
  return data as T;
}

export function normalizeFreeDomain(input: string, fallback: string) {
  const raw = input.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  const withoutSuffix = raw.replace(/\.vercel\.app$/i, "");
  return withoutSuffix.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || fallback;
}

export async function freeDomainForProject(project: Project) {
  const [row] = await db.select({ domain: domains.domain }).from(domains).where(eq(domains.projectId, project.id)).limit(1);
  return row?.domain ?? `${normalizeFreeDomain(project.name, project.slug)}.vercel.app`;
}

function vercelProjectName(project: Project) { return `vo-${project.id.replace(/[^a-z0-9]/gi, "").slice(0, 18).toLowerCase()}`; }
function repoParts(fullName: string) { const [org, ...rest] = fullName.split("/"); const repo = rest.join("/"); if (!org || !repo) throw new Error(`Invalid GitHub repository: ${fullName}`); return { org, repo }; }

async function ensureVercelProject(project: Project) {
  const name = vercelProjectName(project);
  try { return await vercelRequest<{ id: string; name: string }>(`/v9/projects/${encodeURIComponent(name)}${await teamQuery()}`); }
  catch (error) { if (!(error instanceof Error) || !error.message.includes("Vercel API 404")) throw error; }
  return vercelRequest<{ id: string; name: string }>(`/v11/projects${await teamQuery()}`, { method: "POST", body: JSON.stringify({ name, gitRepository: { type: "github", repo: project.repoFullName }, ...(project.framework ? { framework: project.framework } : {}), ...(project.rootDirectory !== "." ? { rootDirectory: project.rootDirectory } : {}), ...(project.installCommand ? { installCommand: project.installCommand } : {}), ...(project.buildCommand ? { buildCommand: project.buildCommand } : {}), ...(project.outputDirectory ? { outputDirectory: project.outputDirectory } : {}), skipGitConnectDuringLink: true }) });
}

async function syncEnvironment(project: Project, vercelProjectId: string) {
  const rows = await db.select().from(envVars).where(and(eq(envVars.projectId, project.id), eq(envVars.scope, "PRODUCTION")));
  for (const row of rows) await vercelRequest(`/v10/projects/${encodeURIComponent(vercelProjectId)}/env${await teamQuery()}`, { method: "POST", body: JSON.stringify({ key: row.key, value: decryptSecret(row.cipher), type: "sensitive", target: ["production"] }) });
}

async function assignFreeAlias(deploymentId: string, domain: string) {
  try {
    await vercelRequest(`/v2/deployments/${encodeURIComponent(deploymentId)}/aliases${await teamQuery()}`, { method: "POST", body: JSON.stringify({ alias: domain }) });
    return domain;
  } catch (error) {
    throw new Error(`Could not assign free deployment domain ${domain}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function shouldUseVercelHosting() { return process.env.VERCEL === "1" || process.env.VERCEL_DEPLOY_PROVIDER === "vercel"; }

export async function launchDeploymentNow(deployment: Deployment, project: Project) {
  if (!shouldUseVercelHosting()) return null;
  if (deployment.status !== "QUEUED") return { status: deployment.status };
  const started = await transition(deployment.id, "BUILDING", { buildStartedAt: new Date() }, { event: "VERCEL_BUILD_STARTED", message: "Deployment handed to Vercel hosting" });
  if (!started) throw new Error("Deployment could not enter BUILDING state");
  try { return await startVercelDeployment(project, { ...deployment, status: "BUILDING" }); }
  catch (error) { await transition(deployment.id, "FAILED", { finishedAt: new Date(), errorReason: error instanceof Error ? error.message : String(error) }, { event: "VERCEL_HANDOFF_FAILED", message: error instanceof Error ? error.message : String(error) }); throw error; }
}

export async function startVercelDeployment(project: Project, deployment: Deployment) {
  if (!shouldUseVercelHosting()) return null;
  const vercelProject = await ensureVercelProject(project);
  await syncEnvironment(project, vercelProject.id).catch(async (error) => { await recordEvent(deployment.id, project.id, "VERCEL_ENV_SYNC_WARNING", error instanceof Error ? error.message : String(error)); });
  const { org, repo } = repoParts(project.repoFullName);
  const created = await vercelRequest<{ id: string; url?: string; readyState?: string }>(`/v13/deployments${await teamQuery()}`, { method: "POST", body: JSON.stringify({ name: vercelProject.name, project: vercelProject.id, target: "production", forceNew: "1", skipAutoDetectionConfirmation: "1", gitSource: { type: "github", org, repo, ref: deployment.branch, sha: deployment.commitSha }, gitMetadata: { remoteUrl: `https://github.com/${project.repoFullName}`, commitRef: deployment.branch, commitSha: deployment.commitSha, commitMessage: deployment.commitMessage ?? "VO deployment", commitAuthorName: deployment.commitAuthor ?? "VO" }, projectSettings: { ...(project.framework ? { framework: project.framework } : {}), ...(project.buildCommand ? { buildCommand: project.buildCommand } : {}), ...(project.installCommand ? { installCommand: project.installCommand } : {}), ...(project.outputDirectory ? { outputDirectory: project.outputDirectory } : {}), ...(project.rootDirectory !== "." ? { rootDirectory: project.rootDirectory } : {}) } }) });
  const temporaryUrl = created.url ? `https://${created.url}` : null;
  let stableUrl = temporaryUrl;
  try { stableUrl = `https://${await assignFreeAlias(created.id, await freeDomainForProject(project))}`; }
  catch (error) { await recordEvent(deployment.id, project.id, "FREE_DOMAIN_PENDING", error instanceof Error ? error.message : String(error)); }
  await db.update(deployments).set({ imageRef: `vercel:${created.id}`, runtimeDriver: "vercel", hostId: "vercel", url: stableUrl, updatedAt: new Date() }).where(eq(deployments.id, deployment.id));
  await recordEvent(deployment.id, project.id, "VERCEL_DEPLOYMENT_CREATED", `Vercel deployment ${created.id} created for ${deployment.commitSha.slice(0, 7)}`, { vercelDeploymentId: created.id, url: stableUrl });
  return { vercelDeploymentId: created.id, url: stableUrl };
}

export async function syncVercelDeployment(deployment: Deployment) {
  if (deployment.runtimeDriver !== "vercel" || !deployment.imageRef?.startsWith("vercel:")) return deployment;
  const vercelDeploymentId = deployment.imageRef.slice("vercel:".length);
  const current = await vercelRequest<{ id: string; readyState?: string; url?: string; error?: { message?: string } }>(`/v13/deployments/${encodeURIComponent(vercelDeploymentId)}${await teamQuery()}`);
  if (current.readyState === "READY" && deployment.status !== "PROMOTED") {
    const project = (await db.select().from(projects).where(eq(projects.id, deployment.projectId)).limit(1))[0];
    let freeUrl = deployment.url ?? (current.url ? `https://${current.url}` : null);
    if (project) { try { freeUrl = `https://${await assignFreeAlias(vercelDeploymentId, await freeDomainForProject(project))}`; } catch (error) { await recordEvent(deployment.id, deployment.projectId, "FREE_DOMAIN_WARNING", error instanceof Error ? error.message : String(error)); } }
    const built = await transition(deployment.id, "BUILT", { buildEndedAt: new Date(), url: freeUrl }, { event: "VERCEL_BUILD_SUCCEEDED", message: "Vercel build completed" });
    if (built) {
      await transition(deployment.id, "STARTING"); await transition(deployment.id, "HEALTH_CHECKING"); await transition(deployment.id, "HEALTHY", { healthyAt: new Date(), url: freeUrl }); await transition(deployment.id, "PROMOTING"); await transition(deployment.id, "PROMOTED", { promotedAt: new Date(), finishedAt: new Date(), url: freeUrl });
      await db.update(projects).set({ currentHealthyDeploymentId: deployment.id, lastSuccessfulCommitSha: deployment.commitSha, updatedAt: new Date() }).where(eq(projects.id, deployment.projectId));
    }
    return { ...deployment, status: "PROMOTED" as const, url: freeUrl };
  }
  if (current.readyState === "ERROR" || current.readyState === "CANCELED") {
    await transition(deployment.id, "FAILED", { finishedAt: new Date(), errorReason: current.error?.message ?? `Vercel deployment ${current.readyState.toLowerCase()}` }, { event: "VERCEL_DEPLOYMENT_FAILED", message: current.error?.message ?? current.readyState });
    await db.update(projects).set({ lastFailedCommitSha: deployment.commitSha, updatedAt: new Date() }).where(eq(projects.id, deployment.projectId));
    return { ...deployment, status: "FAILED" as const };
  }
  return deployment;
}
