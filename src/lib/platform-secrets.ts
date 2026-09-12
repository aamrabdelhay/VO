import { sql } from "drizzle-orm";
import { db } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const ALLOWED = new Set([
  "VERCEL_DEPLOY_TOKEN",
  "VERCEL_DEPLOY_TEAM_ID",
  "NVIDIA_API_KEY",
]);

async function ensureTable() {
  await db.execute(sql`
    create table if not exists platform_secrets (
      key text primary key,
      cipher jsonb not null,
      last_four text,
      updated_at timestamptz not null default now(),
      updated_by text
    )
  `);
}

function assertAllowed(key: string) {
  if (!ALLOWED.has(key)) throw new Error(`Unsupported platform secret: ${key}`);
}

export function isPlatformSecretKey(key: string) {
  return ALLOWED.has(key);
}

export async function setPlatformSecret(key: string, value: string, userId: string) {
  assertAllowed(key);
  if (!value) throw new Error("Secret value is required");
  await ensureTable();
  const cipher = encryptSecret(value);
  await db.execute(sql`
    insert into platform_secrets (key, cipher, last_four, updated_at, updated_by)
    values (${key}, ${JSON.stringify(cipher)}::jsonb, ${value.slice(-4)}, now(), ${userId})
    on conflict (key) do update set
      cipher = excluded.cipher,
      last_four = excluded.last_four,
      updated_at = now(),
      updated_by = excluded.updated_by
  `);
}

export async function getPlatformSecret(key: string): Promise<string | null> {
  assertAllowed(key);
  await ensureTable();
  const result = await db.execute<{ cipher: unknown }>(sql`
    select cipher from platform_secrets where key = ${key} limit 1
  `);
  const row = result.rows?.[0];
  if (!row?.cipher) return null;
  return decryptSecret(row.cipher);
}

export async function listPlatformSecretMetadata() {
  await ensureTable();
  const result = await db.execute<{ key: string; last_four: string | null; updated_at: string }>(sql`
    select key, last_four, updated_at
    from platform_secrets
    order by key
  `);
  return result.rows ?? [];
}

export async function deletePlatformSecret(key: string) {
  assertAllowed(key);
  await ensureTable();
  await db.execute(sql`delete from platform_secrets where key = ${key}`);
}
