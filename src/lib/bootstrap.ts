import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { hosts, organizations, users } from "@/db/schema";
import { createUser } from "@/lib/auth";
import { log } from "@/lib/logger";
import { getRuntimeDriver } from "@/lib/runtime";

let done = false;

/** Idempotent first-run setup: owner account, default org, host registration. */
export async function bootstrapPlatform() {
  if (done) return;
  done = true;

  await db.execute(sql`select 1`);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(users);
  if (Number(count) === 0) {
    const email = process.env.PLATFORM_ADMIN_EMAIL ?? "admin@platform.local";
    const password = process.env.PLATFORM_ADMIN_PASSWORD ?? "platform-admin";
    const { user } = await createUser(email, "Platform Owner", password);
    await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));
    log.info("Bootstrapped platform owner account", { email });
  }

  const [org] = await db.select().from(organizations).limit(1);
  const driver = await getRuntimeDriver();
  await db
    .insert(hosts)
    .values({
      id: process.env.PLATFORM_HOST_ID ?? "local",
      region: process.env.PLATFORM_REGION ?? "local",
      driver: driver.name,
      healthy: true,
      lastHeartbeatAt: new Date(),
    })
    .onConflictDoUpdate({
      target: hosts.id,
      set: { healthy: true, driver: driver.name, lastHeartbeatAt: new Date() },
    });

  log.info("Platform bootstrap complete", { orgId: org?.id, runtimeDriver: driver.name });
}
