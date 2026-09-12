import { handle, ok, readJson, requireFields } from "@/lib/api";
import { assertCsrf, HttpError, requirePlatformAdmin } from "@/lib/auth";
import { deletePlatformSecret, isPlatformSecretKey, listPlatformSecretMetadata, setPlatformSecret, verifyPlatformSecret, verifyPlatformSecretById } from "@/lib/platform-secrets";

export const dynamic = "force-dynamic";
type Body = { key?: string; value?: string; id?: string; action?: "set" | "delete" | "verify" };
export async function GET() { return handle(async () => { await requirePlatformAdmin(); return ok({ secrets: await listPlatformSecretMetadata() }); }); }
export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin(); await assertCsrf(user); const body = await readJson<Body>(request); const action = body.action ?? "set";
    if (action === "verify") { if (body.id) return ok({ check: await verifyPlatformSecretById(body.id) }); requireFields(body, ["key"]); if (!isPlatformSecretKey(body.key!)) throw new HttpError(400, "Unsupported platform secret"); return ok({ check: await verifyPlatformSecret(body.key!, body.value) }); }
    if (action === "delete") { requireFields(body, ["id"]); await deletePlatformSecret(body.id!); return ok({ deleted: true, id: body.id }); }
    requireFields(body, ["key", "value"]); if (!isPlatformSecretKey(body.key!)) throw new HttpError(400, "Unsupported platform secret"); const id = await setPlatformSecret(body.key!, body.value!, user.id); const check = await verifyPlatformSecret(body.key!, body.value); return ok({ saved: true, id, key: body.key, check });
  });
}
