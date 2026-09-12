import { handle, ok, readJson, requireFields } from "@/lib/api";
import { assertCsrf, HttpError, requirePlatformAdmin } from "@/lib/auth";
import {
  deletePlatformSecret,
  isPlatformSecretKey,
  listPlatformSecretMetadata,
  setPlatformSecret,
} from "@/lib/platform-secrets";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    await requirePlatformAdmin();
    return ok({ secrets: await listPlatformSecretMetadata() });
  });
}

type Body = { key: string; value?: string; action?: "set" | "delete" };

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requirePlatformAdmin();
    await assertCsrf(user);
    const body = await readJson<Body>(request);
    requireFields(body, ["key"]);
    if (!isPlatformSecretKey(body.key)) throw new HttpError(400, "Unsupported platform secret");

    if (body.action === "delete") {
      await deletePlatformSecret(body.key);
      return ok({ deleted: true });
    }

    requireFields(body, ["value"]);
    await setPlatformSecret(body.key, body.value!, user.id);
    return ok({ saved: true, key: body.key });
  });
}
