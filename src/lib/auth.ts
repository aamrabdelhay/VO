import { cookies, headers } from "next/headers";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { memberships, organizations, projects, sessions, users } from "@/db/schema";
import { repairOperationalSchema } from "@/db/repair";
import { hashPassword, randomToken, sha256, verifyPassword } from "@/lib/crypto";

export const SESSION_COOKIE = "platform_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

// Direct-access mode: no email/password login is required. Set PLATFORM_AUTH_DISABLED=0
// to restore the normal authenticated flow.
const AUTH_DISABLED = process.env.PLATFORM_AUTH_DISABLED !== "0";
const BYPASS_CSRF_TOKEN = "temporary-preview-bypass";

export type Role = "OWNER" | "ADMIN" | "DEVELOPER" | "VIEWER";
const ROLE_RANK: Record<Role, number> = { VIEWER: 0, DEVELOPER: 1, ADMIN: 2, OWNER: 3 };

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  sessionId: string;
  csrfToken: string;
};

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function createUser(email: string, name: string, password: string) {
  const [user] = await db
    .insert(users)
    .values({ email: email.toLowerCase().trim(), name, passwordHash: hashPassword(password) })
    .returning();
  const slug = email.toLowerCase().split("@")[0].replace(/[^a-z0-9-]/g, "-") + "-org";
  const [org] = await db
    .insert(organizations)
    .values({ name: `${name}'s workspace`, slug: `${slug}-${user.id.slice(0, 6)}` })
    .returning();
  await db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "OWNER" });
  return { user, org };
}

export async function authenticate(email: string, password: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase().trim())).limit(1);
  if (!user || !verifyPassword(password, user.passwordHash)) return null;
  return user;
}

export async function startSession(userId: string) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const h = await headers();
  await db.insert(sessions).values({
    userId,
    tokenHash: sha256(token),
    csrfToken,
    userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return { token, csrfToken };
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, sha256(token)));
  jar.delete(SESSION_COOKIE);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  await repairOperationalSchema();

  if (AUTH_DISABLED) {
    let [user] = await db.select().from(users).limit(1);
    if (!user) {
      const email = process.env.PLATFORM_ADMIN_EMAIL ?? "preview@platform.local";
      const created = await createUser(email, "Platform Owner", randomToken(32));
      await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, created.user.id));
      user = { ...created.user, isPlatformAdmin: true };
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isPlatformAdmin: true,
      sessionId: "temporary-preview",
      csrfToken: BYPASS_CSRF_TOKEN,
    };
  }

  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, sha256(token)),
        gt(sessions.expiresAt, new Date()),
        isNull(sessions.revokedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.user.id,
    email: row.user.email,
    name: row.user.name,
    isPlatformAdmin: row.user.isPlatformAdmin,
    sessionId: row.session.id,
    csrfToken: row.session.csrfToken,
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Authentication required");
  return user;
}

export async function requirePlatformAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isPlatformAdmin) throw new HttpError(403, "Platform administrator role required");
  return user;
}

export async function orgRole(userId: string, orgId: string): Promise<Role | null> {
  const [m] = await db.select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId))).limit(1);
  return (m?.role as Role) ?? null;
}

export async function primaryOrg(userId: string) {
  const rows = await db
    .select({ org: organizations, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireProjectAccess(projectId: string, minRole: Role = "VIEWER") {
  const user = await requireUser();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new HttpError(404, "Project not found");
  const role = await orgRole(user.id, project.orgId);
  if (!role && !user.isPlatformAdmin) throw new HttpError(404, "Project not found");
  const effective: Role = role ?? "ADMIN";
  if (ROLE_RANK[effective] < ROLE_RANK[minRole]) throw new HttpError(403, `Requires ${minRole} role`);
  return { user, project, role: effective };
}

export async function assertCsrf(user: SessionUser) {
  if (AUTH_DISABLED) return;
  const h = await headers();
  const provided = h.get("x-csrf-token");
  if (!provided || provided !== user.csrfToken) throw new HttpError(403, "Invalid CSRF token");
}
