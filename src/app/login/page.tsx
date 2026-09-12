import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSessionUser } from "@/lib/auth";
import { LoginForm } from "@/components/client";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/dashboard");
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(users);
  const allowRegister = Number(count) === 0 || process.env.PLATFORM_OPEN_SIGNUP === "1";

  return (
    <main className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-[340px]">
        <div className="mb-6">
          <div className="mb-2 flex items-center gap-2">
            <span
              aria-hidden
              style={{ width: 14, height: 14, background: "#fafafa", borderRadius: 3, display: "block" }}
            />
            <span className="text-[13px] font-semibold">Deployment Platform</span>
          </div>
          <p style={{ color: "var(--color-fg-muted)" }}>
            Control plane for GitHub-driven builds, promotion and rollback.
          </p>
        </div>
        <div className="panel p-4">
          <LoginForm allowRegister={allowRegister} />
        </div>
        <p className="hint mt-4">
          First run creates the owner account from PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD
          (default admin@platform.local / platform-admin).
        </p>
      </div>
    </main>
  );
}
