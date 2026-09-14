import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { garvexMemories } from "@/db/schema";
import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";

export async function GET() {
  await requirePlatformAdmin();
  const rows = await db.select({ id: garvexMemories.id, content: garvexMemories.content, projectId: garvexMemories.projectId, createdAt: garvexMemories.createdAt, lastUsedAt: garvexMemories.lastUsedAt, useCount: garvexMemories.useCount }).from(garvexMemories).orderBy(desc(garvexMemories.lastUsedAt), desc(garvexMemories.createdAt)).limit(200);
  return Response.json({ data: rows });
}

export async function DELETE(request: Request) {
  const user = await requirePlatformAdmin();
  await assertCsrf(user);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  await db.delete(garvexMemories).where(eq(garvexMemories.id, id));
  return Response.json({ data: { deleted: true } });
}
