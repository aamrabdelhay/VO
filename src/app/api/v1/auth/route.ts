import { headers } from "next/headers";
import { fail, handle, ok, rateLimit, readJson, requireFields } from "@/lib/api";
import {
  authenticate,
  createUser,
  endSession,
  getSessionUser,
  primaryOrg,
  startSession,
} from "@/lib/auth";
import { audit } from "@/lib/audit";
import { db } from "@/db";
import { users } from "@/db/schema";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const user = await getSessionUser();
    if (!user) return fail(401, "Not authenticated");
    const org = await primaryOrg(user.id);
    return ok({ user, org: org?.org ?? null, role: org?.role ?? null });
  });
}

type Body = { action: "login" | "register" | "logout"; email?: string; password?: string; name?: string };

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson<Body>(request);
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0] ?? "local";

    if (body.action === "logout") {
      await endSession();
      return ok({ loggedOut: true });
    }

    rateLimit(`auth:${ip}`, 10, 60_000);
    requireFields(body, ["email", "password"]);

    if (body.action === "register") {
      const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(users);
      if (Number(count) > 0 && process.env.PLATFORM_OPEN_SIGNUP !== "1") {
        return fail(403, "Self-service signup is disabled on this platform");
      }
      const { user, org } = await createUser(body.email!, body.name ?? body.email!, body.password!);
      const session = await startSession(user.id);
      await audit({
        orgId: org.id,
        actorId: user.id,
        action: "user.registered",
        resourceType: "user",
        resourceId: user.id,
        ip,
      });
      return ok({ user: { id: user.id, email: user.email }, csrfToken: session.csrfToken });
    }

    const user = await authenticate(body.email!, body.password!);
    if (!user) return fail(401, "Invalid credentials");
    const session = await startSession(user.id);
    await audit({
      actorId: user.id,
      action: "user.login",
      resourceType: "session",
      resourceId: user.id,
      ip,
    });
    return ok({ user: { id: user.id, email: user.email }, csrfToken: session.csrfToken });
  });
}
