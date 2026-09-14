import { requirePlatformAdmin } from "@/lib/auth";
import { GarvexMemoryPanel } from "@/components/garvex-memory-panel";

export const dynamic = "force-dynamic";

export default async function GarvexMemoryPage() {
  const user = await requirePlatformAdmin();
  return <main style={{ maxWidth: 960, margin: "40px auto", padding: 24 }}><GarvexMemoryPanel csrf={user.csrfToken} /></main>;
}
