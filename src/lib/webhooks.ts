import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { deployments, githubWebhookDeliveries, projects } from "@/db/schema";
import { createDeployment, expirePreview } from "@/lib/deploy";
import { installationToken } from "@/lib/github-auth";
import { upsertPrComment } from "@/lib/github";
import { log } from "@/lib/logger";
import { previewHost } from "@/lib/router";

type PushPayload = {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { full_name?: string };
  head_commit?: { id: string; message: string; timestamp: string; author?: { name?: string } };
  pusher?: { name?: string };
};

type PullRequestPayload = {
  action?: string;
  number?: number;
  repository?: { full_name?: string };
  pull_request?: {
    number: number;
    head: { ref: string; sha: string };
    base: { ref: string };
    title: string;
    user?: { login?: string };
  };
};

export async function processWebhook(deliveryId: string) {
  const [delivery] = await db
    .select()
    .from(githubWebhookDeliveries)
    .where(eq(githubWebhookDeliveries.deliveryId, deliveryId))
    .limit(1);
  if (!delivery) return { ok: false, reason: "unknown delivery" };
  if (delivery.processed) return { ok: true, reason: "already processed" };
  return { ok: true, reason: delivery.result ?? "processed" };
}

export async function handlePush(payload: PushPayload, deliveryId: string) {
  const repoFullName = payload.repository?.full_name;
  const ref = payload.ref ?? "";
  if (!repoFullName || !ref.startsWith("refs/heads/")) return "ignored: not a branch push";
  if (payload.deleted) return "ignored: branch deleted";
  const branch = ref.replace("refs/heads/", "");
  const sha = payload.after ?? payload.head_commit?.id;
  if (!sha || /^0+$/.test(sha)) return "ignored: no commit";

  const matching = await db
    .select()
    .from(projects)
    .where(and(eq(projects.repoFullName, repoFullName), eq(projects.enabled, true)));
  if (matching.length === 0) return "ignored: no project mapped to repository";

  const results: string[] = [];
  for (const project of matching) {
    if (project.productionBranch === branch) {
      const deployment = await createDeployment({
        project,
        commitSha: sha,
        branch,
        target: "PRODUCTION",
        commitMessage: payload.head_commit?.message ?? null,
        commitAuthor: payload.head_commit?.author?.name ?? payload.pusher?.name ?? null,
        commitTimestamp: payload.head_commit?.timestamp
          ? new Date(payload.head_commit.timestamp)
          : null,
        triggeredBy: payload.pusher?.name ?? "github",
        triggerSource: "github-push",
        correlationId: deliveryId,
      });
      results.push(`production deployment ${deployment.id}`);
    } else if (project.previewsEnabled) {
      // Branch previews reuse the latest commit per branch (one active runtime).
      const active = await db
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.projectId, project.id),
            eq(deployments.target, "PREVIEW"),
            eq(deployments.branch, branch),
            inArray(deployments.status, ["PROMOTED", "HEALTHY", "BUILT", "STARTING"]),
          ),
        );
      for (const previous of active) {
        await expirePreview(previous.id, "superseded by newer preview commit");
      }
      const deployment = await createDeployment({
        project,
        commitSha: sha,
        branch,
        target: "PREVIEW",
        commitMessage: payload.head_commit?.message ?? null,
        commitAuthor: payload.head_commit?.author?.name ?? null,
        triggeredBy: payload.pusher?.name ?? "github",
        triggerSource: "github-push",
        correlationId: deliveryId,
      });
      results.push(`preview deployment ${deployment.id}`);
    }
  }
  return results.join(", ") || "ignored: branch not configured";
}

export async function handlePullRequest(payload: PullRequestPayload, deliveryId: string) {
  const repoFullName = payload.repository?.full_name;
  const pr = payload.pull_request;
  if (!repoFullName || !pr) return "ignored: incomplete payload";

  const matching = await db
    .select()
    .from(projects)
    .where(and(eq(projects.repoFullName, repoFullName), eq(projects.enabled, true)));
  if (matching.length === 0) return "ignored: no project mapped";

  const results: string[] = [];
  for (const project of matching) {
    if (!project.previewsEnabled) continue;
    if (["closed", "converted_to_draft"].includes(payload.action ?? "")) {
      const previews = await db
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.projectId, project.id),
            eq(deployments.target, "PREVIEW"),
            eq(deployments.prNumber, pr.number),
          ),
        )
        .orderBy(desc(deployments.queuedAt));
      for (const preview of previews) {
        await expirePreview(preview.id, `pull request #${pr.number} closed`);
      }
      results.push(`expired ${previews.length} preview(s) for PR #${pr.number}`);
      continue;
    }
    if (!["opened", "synchronize", "reopened", "ready_for_review"].includes(payload.action ?? "")) {
      continue;
    }
    const active = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, project.id),
          eq(deployments.target, "PREVIEW"),
          eq(deployments.prNumber, pr.number),
          inArray(deployments.status, ["PROMOTED", "HEALTHY", "BUILT", "STARTING"]),
        ),
      );
    for (const previous of active) await expirePreview(previous.id, "superseded by new PR commit");

    const deployment = await createDeployment({
      project,
      commitSha: pr.head.sha,
      branch: pr.head.ref,
      target: "PREVIEW",
      prNumber: pr.number,
      commitMessage: pr.title,
      commitAuthor: pr.user?.login ?? null,
      triggeredBy: pr.user?.login ?? "github",
      triggerSource: "github-pull-request",
      correlationId: deliveryId,
    });
    results.push(`preview deployment ${deployment.id}`);

    const token = await installationToken(project.orgId);
    if (token) {
      const url = `https://${previewHost(project.slug, pr.number, pr.head.ref)}`;
      await upsertPrComment(
        project.repoFullName,
        pr.number,
        token,
        `<!-- deploy-platform:${project.id} -->`,
        [
          `**Preview deployment** for \`${pr.head.sha.slice(0, 7)}\``,
          "",
          `| Project | Status | Preview |`,
          `| --- | --- | --- |`,
          `| ${project.name} | building | ${url} |`,
        ].join("\n"),
      ).catch((e) => log.warn("PR comment failed", { error: String(e) }));
    }
  }
  return results.join(", ") || "ignored: previews disabled";
}
