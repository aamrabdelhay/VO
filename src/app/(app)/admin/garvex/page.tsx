import { requirePlatformAdmin } from "@/lib/auth";
import { getGarvexProviderStatus } from "@/lib/ai/provider";
import { GarvexConsole } from "@/components/garvex-console";

export const dynamic = "force-dynamic";

export default async function GarvexPage() {
  const user = await requirePlatformAdmin();
  const providers = await getGarvexProviderStatus();
  return <GarvexConsole csrf={user.csrfToken} providers={providers} isPlatformAdmin={user.isPlatformAdmin} />;
}
