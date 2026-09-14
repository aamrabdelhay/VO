import { handle, ok } from "@/lib/api";
import { requirePlatformAdmin } from "@/lib/auth";
import { resolveAIConfig, spentTodayCents } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    const config = await resolveAIConfig(user.id);
    const spentTodayCentsValue = await spentTodayCents(user.id);
    const budgetCents = config?.dailyBudgetCents ?? 0;
    return ok({ spentTodayCents: spentTodayCentsValue, budgetCents, remainingCents: Math.max(0, budgetCents - spentTodayCentsValue), provider: config?.provider ?? null, model: config?.model ?? null });
  });
}
