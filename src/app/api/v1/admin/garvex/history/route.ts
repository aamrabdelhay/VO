import { handle, ok, readJson } from "@/lib/api";
import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { deleteGarvexChat, getGarvexChat, listGarvexChats, saveGarvexChat, type GarvexHistoryMessage } from "@/lib/garvex-history";

export const dynamic = "force-dynamic";

type Body = { id?: string; projectId?: string | null; title?: string; messages?: GarvexHistoryMessage[] };

export async function GET(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) return ok({ chat: await getGarvexChat(user.id, id) });
    return ok({ chats: await listGarvexChats(user.id) });
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const body = await readJson<Body>(request);
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error("messages are required");
    const id = await saveGarvexChat({ userId: user.id, id: body.id, projectId: body.projectId, title: body.title ?? body.messages.find((m) => m.role === "user")?.content ?? "New Garvex chat", messages: body.messages });
    return ok({ id });
  });
}

export async function DELETE(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const url = new URL(request.url);
    await deleteGarvexChat(user.id, url.searchParams.get("id") || undefined);
    return ok({ deleted: true });
  });
}
