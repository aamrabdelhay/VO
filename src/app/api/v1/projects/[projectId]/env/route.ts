import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { envVars, secretVersions } from "@/db/schema";
import { handle, ok, readJson, requireFields } from "@/lib/api";
import { assertCsrf, HttpError, requireProjectAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

type Scope = "DEVELOPMENT" | "PREVIEW" | "PRODUCTION";

export async function GET(_: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    await requireProjectAccess(projectId);
    const rows = await db.select().from(envVars).where(eq(envVars.projectId, projectId));
    // Values are never returned; only masked metadata.
    return ok({
      envVars: rows.map((r) => ({
        id: r.id,
        key: r.key,
        scope: r.scope,
        version: r.version,
        masked: `••••${r.lastFour ?? ""}`,
        updatedAt: r.updatedAt,
      })),
    });
  });
}

type Body = { key: string; value: string; scope?: Scope };

export async function POST(request: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { user, project } = await requireProjectAccess(projectId, "ADMIN");
    await assertCsrf(user);
    const body = await readJson<Body>(request);
    requireFields(body, ["key", "value"]);
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(body.key)) throw new HttpError(400, "Invalid variable name");
    const scope: Scope = body.scope ?? "PRODUCTION";
    const cipher = encryptSecret(body.value) as unknown as object;
    const lastFour = body.value.slice(-4);

    const [existing] = await db
      .select()
      .from(envVars)
      .where(and(eq(envVars.projectId, projectId), eq(envVars.key, body.key), eq(envVars.scope, scope)))
      .limit(1);

    let row;
    if (existing) {
      await db.insert(secretVersions).values({
        envVarId: existing.id,
        version: existing.version,
        cipher: existing.cipher as object,
        createdBy: user.id,
      });
      [row] = await db
        .update(envVars)
        .set({ cipher, lastFour, version: existing.version + 1, updatedAt: new Date() })
        .where(eq(envVars.id, existing.id))
        .returning();
    } else {
      [row] = await db
        .insert(envVars)
        .values({ projectId, key: body.key, scope, cipher, lastFour, createdBy: user.id })
        .returning();
    }

    await audit({
      orgId: project.orgId,
      projectId,
      actorId: user.id,
      action: existing ? "env.updated" : "env.created",
      resourceType: "env_var",
      resourceId: row.id,
      newState: { key: body.key, scope, version: row.version },
    });
    return ok({ envVar: { id: row.id, key: row.key, scope: row.scope, version: row.version } });
  });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { user, project } = await requireProjectAccess(projectId, "ADMIN");
    await assertCsrf(user);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new HttpError(400, "id is required");
    const [deleted] = await db
      .delete(envVars)
      .where(and(eq(envVars.id, id), eq(envVars.projectId, projectId)))
      .returning();
    if (!deleted) throw new HttpError(404, "Variable not found");
    await audit({
      orgId: project.orgId,
      projectId,
      actorId: user.id,
      action: "env.deleted",
      resourceType: "env_var",
      resourceId: id,
      oldState: { key: deleted.key, scope: deleted.scope },
    });
    return ok({ deleted: true });
  });
}
