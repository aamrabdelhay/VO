import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { githubWebhookDeliveries, projects } from "@/db/schema";
import { decryptSecret, sha256, verifyGithubSignature } from "@/lib/crypto";
import { log } from "@/lib/logger";
import { handlePullRequest, handlePush } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

/**
 * GitHub webhook receiver.
 * Verifies the signature, durably deduplicates the delivery, resolves the
 * project, updates desired state and enqueues work — then returns immediately.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const event = request.headers.get("x-github-event") ?? "unknown";
  const deliveryId = request.headers.get("x-github-delivery");
  const signature = request.headers.get("x-hub-signature-256");

  if (!deliveryId) return Response.json({ error: "Missing delivery id" }, { status: 400 });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }
  const repoFullName =
    (payload.repository as { full_name?: string } | undefined)?.full_name ?? null;

  // Deduplicate first: the same delivery must never create duplicate work.
  const inserted = await db
    .insert(githubWebhookDeliveries)
    .values({
      deliveryId,
      event,
      repoFullName,
      payloadDigest: sha256(raw),
      signatureValid: false,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    await db
      .update(githubWebhookDeliveries)
      .set({ duplicate: true })
      .where(eq(githubWebhookDeliveries.deliveryId, deliveryId));
    log.info("Duplicate GitHub delivery ignored", { deliveryId, event });
    return Response.json({ ok: true, duplicate: true });
  }

  // Signature verification against every project secret mapped to this repo.
  let signatureValid = false;
  let matchedProjectId: string | null = null;
  if (repoFullName) {
    const mapped = await db
      .select()
      .from(projects)
      .where(and(eq(projects.repoFullName, repoFullName)));
    for (const project of mapped) {
      if (!project.webhookSecretCipher) continue;
      try {
        const secret = decryptSecret(project.webhookSecretCipher);
        if (verifyGithubSignature(secret, raw, signature)) {
          signatureValid = true;
          matchedProjectId = project.id;
          break;
        }
      } catch {
        continue;
      }
    }
  }
  const globalSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!signatureValid && globalSecret && verifyGithubSignature(globalSecret, raw, signature)) {
    signatureValid = true;
  }

  if (!signatureValid) {
    await db
      .update(githubWebhookDeliveries)
      .set({ processed: true, result: "rejected: invalid signature" })
      .where(eq(githubWebhookDeliveries.deliveryId, deliveryId));
    log.warn("Rejected GitHub webhook with invalid signature", { deliveryId, event });
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let result = "ignored";
  try {
    if (event === "push") result = await handlePush(payload, deliveryId);
    else if (event === "pull_request") result = await handlePullRequest(payload, deliveryId);
    else if (event === "ping") result = "pong";
    else result = `ignored: unsupported event ${event}`;
  } catch (error) {
    result = `error: ${error instanceof Error ? error.message : String(error)}`;
    log.error("Webhook processing failed", { deliveryId, event, error: result });
  }

  await db
    .update(githubWebhookDeliveries)
    .set({ signatureValid: true, processed: true, result, projectId: matchedProjectId })
    .where(eq(githubWebhookDeliveries.deliveryId, deliveryId));

  return Response.json({ ok: true, result });
}
