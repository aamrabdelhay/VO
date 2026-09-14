import { handle, ok, readJson } from "@/lib/api";
import { assertCsrf, requirePlatformAdmin } from "@/lib/auth";
import { saveAIFeedback } from "@/lib/ai-feedback";

export const dynamic = "force-dynamic";
type Body = { messageId?: string; rating?: "up" | "down"; note?: string };

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const body = await readJson<Body>(request);
    if (!body.messageId || !body.rating) throw new Error("messageId and rating are required");
    await saveAIFeedback({ messageId: body.messageId, userId: user.id, rating: body.rating, note: body.note });
    return ok({ saved: true });
  });
}
