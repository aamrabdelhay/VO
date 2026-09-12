import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments, domains, projects } from "@/db/schema";
import { transition, recordEvent } from "@/lib/state-machine";
import { decryptSecret } from "@/lib/crypto";
import { envVars } from "@/db/schema";

type Project = typeof projects.$inferSelect;
type Deployment = typeof deployments.$inferSelect;

const API = "https://api.vercel.com";

function token() {
  return process.env.VERCEL_DEPLOY_TOKEN || process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN || "";
}

function teamQuery() {
  const teamId = process.env.VERCEL_DEPLOY_TEAM_ID || process.env.VERCEL_TEAM_ID;
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}

async function vercelRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = token();
  if (!auth) {
    throw new Error(
      "Vercel deployment provider is not configured. Add VERCEL_DEPLOY_TOKEN (or VERCEL_OIDC_TOKEN) to the VO deployment environment.",
    );
  }
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: { message: text || `Vercel request failed (${response.status})` } };
  }
  if (!response.ok) {
    const message =
      typeof data === "object" && data && "error" in data
        ? String((data as { error?: { message?: unknown } }).error?.message ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`;
    throw new Error(`Vercel API ${response.status}: ${message}`);
  }
  return data as T;
}

export function normalizeFreeDomain(input: string, fallback: string) {
  const raw = input.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  const withoutSuffix = raw.replace(/\.vercel\.app$/i, "");
  const label = withoutSuffix.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return label || fallback;
}

function vercelProjectName(project: Project) {
  return `vo-${project.id.replace(/[^a-z0-9]/gi, "").slice(0, 18).toLowerCase()}`;
}

function repoParts(fullName: string) {
  const [org, ...rest] = fullName.split("/");
  const repo = rest.join("/");
  if (!org || !repo) throw new Error(`Invalid GitHub repository: ${fullName}`);
  return { org, repo };
}

async function ensureVercelProject(project: Project) {
  const name = vercelProjectName(project);
  try {
    return await vercelRequest<{ id: string; name: string }>(
      `/v9/projects/${encodeURIComponent(name)}${teamQuery()}`,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Vercel API 404")) throw error;
  }

  return vercelRequest<{ id: string; name: string }>(`/v11/projects${teamQuery()}`, {
    method: "POST",
    body: JSON.stringify({
      name,
      gitRepository: { type: "github", repo: project.repoFullName },
      framework: project.framework || null,
      rootDirectory: project.rootDirectory === "." ? undefined : project.rootDirectory,
      installCommand: project.installCommand || undefined,
      buildCommand: project.buildCommand || undefined,
      outputDirectory: project.outputDirectory || undefined,
      skipGitConnectDuringLink: true,
    }),
  });
}

async function syncEnvironment(project: Project, vercelProjectId: string) {
  const rows = await db
    .select()
    .from(envVars)
    .where(and(eq(envVars.projectId, project.id), eq(envVars.scope, "PRODUCTION")));
  if (!rows.length) return;

  const body = rows.map((row) => ({
    key: row.key,
    value: decryptSecret(row.cipher),
    type: "sensitive",
    target: ["production"],
  }));
  await vercelRequest(`/v10/projects/${encodeURIComponent(vercelProjectId)}/env${teamQuery()}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function assignFreeAlias(deploymentId: string, project: Project) {
  const preferred = `${normalizeFreeDomain(project.freeDomain, project.slug)}.vercel.app`;
  try {
    await vercelRequest(`/v2/deployments/${encodeURIComponent(deploymentId)}/aliases${teamQuery()}`, {
      method: "POST",
      body: JSON.stringify({ alias: preferred }),
    });
    return preferred;
  } catch {
    const fallback = `${normalizeFreeDomain(project.freeDomain, project.slug)}-${project.id
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 6)
      .toLowerCase()}.vercel.app`;
    await vercelRequest(`/v2/deployments/${encodeURIComponent(deploymentId)}/aliases${teamQuery()}`, {
      method: "POST",
      body: JSON.stringify({ alias: fallback }),
    });
    return fallback;
  }
}

export function shouldUseVercelHosting() {
  return process.env.VERCEL === "1" || process.env.VERCEL_DEPLOY_PROVIDER === "vercel";
}

export async function startVercelDeployment(project: Project, deployment: Deployment) {
  if (!shouldUseVercelHosting()) return null;

  const vercelProject = await ensureVercelProject(project);
  await syncEnvironment(project, vercelProject.id).catch(async (error) => {
    await recordEvent(
      deployment.id,
      project.id,
      "VERCEL_ENV_SYNC_WARNING",
      error instanceof Error ? error.message : String(error),
    );
  });

  const { org, repo } = repoParts(project.repoFullName);
  const created = await vercelRequest<{ id: string; url?: string; readyState?: string }>(
    `/v13/deployments${teamQuery()}`,
    {
      method: "POST",
      body: JSON.stringify({
        name: vercelProject.name,
        project: vercelProject.id,
        target: "production",
        forceNew: "1",
        skipAutoDetectionConfirmation: "1",
        gitSource: {
          type: "github",
          org,
          repo,
          ref: deployment.branch,
          sha: deployment.commitSha,
        },
        gitMetadata: {
          remoteUrl: `https://github.com/${project.repoFullName}`,
          commitRef: deployment.branch,
          commitSha: deployment.commitSha,
          commitMessage: deployment.commitMessage ?? "VO deployment",
          commitAuthorName: deployment.commitAuthor ?? "VO",
        },
        projectSettings: {
          framework: project.framework || undefined,
          buildCommand: project.buildCommand || undefined,
          installCommand: project.installCommand || undefined,
          outputDirectory: project.outputDirectory || undefined,
          rootDirectory: project.rootDirectory === "." ? undefined : project.rootDirectory,
        },
      }),
    },
  );

  const alias = await assignFreeAlias(created.id, project);
  await db
    .update(deployments)
    .set({
      imageRef: `vercel:${created.id}`,
      runtimeDriver: "vercel",
      hostId: "vercel",
      url: `https://${alias}`,
      buildStartedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deployments.id, deployment.id));
  await recordEvent(
    deployment.id,
    project.id,
    "VERCEL_DEPLOYMENT_CREATED",
    `Vercel deployment ${created.id} created for ${deployment.commitSha.slice(0, 7)}`,
    { vercelDeploymentId: created.id, url: `https://${alias}` },
  );
  return { vercelDeploymentId: created.id, url: `https://${alias}` };
}

export async function syncVercelDeployment(deployment: Deployment) {
  if (deployment.runtimeDriver !== "vercel" || !deployment.imageRef?.startsWith("vercel:")) {
    return deployment;
  }
  const vercelDeploymentId = deployment.imageRef.slice("vercel:".length);
  const current = await vercelRequest<{ id: string; readyState?: string; url?: string; error?: { message?: string } }>(
    `/v13/deployments/${encodeURIComponent(vercelDeploymentId)}${teamQuery()}`,
  );
  const state = current.readyState;
  if (state === "READY" && deployment.status !== "PROMOTED") {
    const promoted = await transition(
      deployment.id,
      "BUILT",
      { buildEndedAt: new Date() },
      { event: "VERCEL_BUILD_SUCCEEDED", message: "Vercel build completed" },
    );
    if (promoted) {
      await transition(deployment.id, "STARTING");
      await transition(deployment.id, "HEALTH_CHECKING");
      await transition(deployment.id, "HEALTHY", { healthyAt: new Date() });
      await transition(deployment.id, "PROMOTING");
      await transition(deployment.id, "PROMOTED", { promotedAt: new Date(), finishedAt: new Date() });
      await db
        .update(projects)
        .set({
          currentHealthyDeploymentId: deployment.id,
          lastSuccessfulCommitSha: deployment.commitSha,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, deployment.projectId));
    }
    return {
      ...deployment,
      status: "PROMOTED" as const,
      url: deployment.url ?? (current.url ? `https://${current.url}` : deployment.url),
    };
  }
  if (state === "ERROR" || state === "CANCELED") {
    await transition(
      deployment.id,
      "FAILED",
      { finishedAt: new Date(), errorReason: current.error?.message ?? `Vercel deployment ${state.toLowerCase()}` },
      { event: "VERCEL_DEPLOYMENT_FAILED", message: current.error?.message ?? state },
    );
    await db
      .update(projects)
      .set({ lastFailedCommitSha: deployment.commitSha, updatedAt: new Date() })
      .where(eq(projects.id, deployment.projectId));
    return { ...deployment, status: "FAILED" as const };
  }
  return deployment;
}

export async function freeDomainForProject(project: Project) {
  return `${normalizeFreeDomain(project.freeDomain, project.slug)}.vercel.app`;
}
