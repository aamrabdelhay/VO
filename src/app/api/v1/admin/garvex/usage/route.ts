import { handle, ok } from "@/lib/api";
import { primaryOrg, requirePlatformAdmin } from "@/lib/auth";
import { resolveAIConfig, spentTodayCents } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    const membership = await primaryOrg(user.id);
    const orgId = membership?.org.id ?? user.id;
    const config = await resolveAIConfig(orgId);
    const spentTodayCentsValue = await spentTodayCents(orgId);
    const budgetCents = config?.dailyBudgetCents ?? 0;
    return ok({ spentTodayCents: spentTodayCentsValue, budgetCents, remainingCents: Math.max(0, budgetCents - spentTodayCentsValue), provider: config?.provider ?? null, model: config?.model ?? null });
  });
}
