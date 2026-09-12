import { eq } from "drizzle-orm";
import { db } from "@/db";
import { domains } from "@/db/schema";
import { handle, ok, readJson, requireFields } from "@/lib/api";
import { assertCsrf, HttpError, requireProjectAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { randomToken } from "@/lib/crypto";
import { dnsInstructions, verifyDomain } from "@/lib/domains";
import { platformHost } from "@/lib/router";

export const dynamic = "force-dynamic";

export async function GET(_: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { project } = await requireProjectAccess(projectId);
    const rows = await db.select().from(domains).where(eq(domains.projectId, projectId));
    return ok({
      platformDomain: platformHost(project.slug),
      domains: rows.map((d) => ({ ...d, instructions: dnsInstructions(d, project.slug) })),
    });
  });
}

type Body = { domain?: string; action?: "verify"; domainId?: string };

export async function POST(request: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { user, project } = await requireProjectAccess(projectId, "ADMIN");
    await assertCsrf(user);
    const body = await readJson<Body>(request);

    if (body.action === "verify") {
      if (!body.domainId) throw new HttpError(400, "domainId is required");
      const [record] = await db
        .select()
        .from(domains)
        .where(eq(domains.id, body.domainId))
        .limit(1);
      if (!record || record.projectId !== projectId) throw new HttpError(404, "Domain not found");
      const result = await verifyDomain(record.id);
      return ok(result);
    }

    requireFields(body as Required<Body>, ["domain"]);
    const hostname = String(body.domain).trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) throw new HttpError(400, "Invalid domain");

    const [record] = await db
      .insert(domains)
      .values({
        projectId,
        domain: hostname,
        kind: "custom",
        status: "PENDING",
        verificationToken: randomToken(16),
      })
      .returning();
    await audit({
      orgId: project.orgId,
      projectId,
      actorId: user.id,
      action: "domain.added",
      resourceType: "domain",
      resourceId: record.id,
      newState: { domain: hostname },
    });
    return ok({ domain: record, instructions: dnsInstructions(record, project.slug) });
  });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { user, project } = await requireProjectAccess(projectId, "ADMIN");
    await assertCsrf(user);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new HttpError(400, "id is required");
    const [record] = await db.select().from(domains).where(eq(domains.id, id)).limit(1);
    if (!record || record.projectId !== projectId) throw new HttpError(404, "Domain not found");
    await db.delete(domains).where(eq(domains.id, id));
    const { publishRoutes } = await import("@/lib/router");
    await publishRoutes();
    await audit({
      orgId: project.orgId,
      projectId,
      actorId: user.id,
      action: "domain.removed",
      resourceType: "domain",
      resourceId: id,
      oldState: { domain: record.domain },
    });
    return ok({ deleted: true });
  });
}
