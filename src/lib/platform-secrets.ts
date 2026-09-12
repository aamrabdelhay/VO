import { sql } from "drizzle-orm";
import { db } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const ALLOWED = new Set([
  "VERCEL_DEPLOY_TOKEN",
  "VERCEL_DEPLOY_TEAM_ID",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "KILO_API_KEY",
  "COHERE_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "OLLAMA_API_KEY",
  "GITHUB_TOKEN",
]);

export type SecretCheck = { key: string; ok: boolean; status: number | null; message: string };

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
  const cipher = encryptSecret(value.trim());
  await db.execute(sql`
    insert into platform_secrets (key, cipher, last_four, updated_at, updated_by)
    values (${key}, ${JSON.stringify(cipher)}::jsonb, ${value.trim().slice(-4)}, now(), ${userId})
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

function bearerHeaders(value: string) {
  return { accept: "application/json", authorization: `Bearer ${value}`, "user-agent": "vo-platform" };
}

async function checkResponse(key: string, response: Response, fallback: string): Promise<SecretCheck> {
  if (response.ok) return { key, ok: true, status: response.status, message: "Connected" };
  const body = await response.text();
  let message = fallback;
  try {
    const data = JSON.parse(body) as { error?: { message?: string }; detail?: string; title?: string; message?: string };
    message = data.error?.message ?? data.detail ?? data.title ?? data.message ?? fallback;
  } catch {
    message = body.slice(0, 180) || fallback;
  }
  return { key, ok: false, status: response.status, message };
}

export async function verifyPlatformSecret(key: string, valueOverride?: string): Promise<SecretCheck> {
  assertAllowed(key);
  const value = valueOverride?.trim() || (await getPlatformSecret(key));
  if (!value) return { key, ok: false, status: null, message: "Not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    let response: Response;
    switch (key) {
      case "GITHUB_TOKEN":
        response = await fetch("https://api.github.com/user", { headers: { ...bearerHeaders(value), accept: "application/vnd.github+json" }, signal: controller.signal, cache: "no-store" });
        return await checkResponse(key, response, "GitHub authentication failed");
      case "NVIDIA_API_KEY":
        response = await fetch("https://integrate.api.nvidia.com/v1/models", { headers: bearerHeaders(value), signal: controller.signal, cache: "no-store" });
        return await checkResponse(key, response, "NVIDIA authentication failed");
      case "OPENROUTER_API_KEY":
        response = await fetch("https://openrouter.ai/api/v1/models", { headers: { ...bearerHeaders(value), "http-referer": "https://vo-lilac.vercel.app", "x-title": "VO Garvex" }, signal: controller.signal, cache: "no-store" });
        return await checkResponse(key, response, "OpenRouter authentication failed");
      case "MISTRAL_API_KEY":
        response = await fetch("https://api.mistral.ai/v1/models", { headers: bearerHeaders(value), signal: controller.signal, cache: "no-store" });
        return await checkResponse(key, response, "Mistral authentication failed");
      case "CEREBRAS_API_KEY":
        response = await fetch("https://api.cerebras.ai/v1/models", { headers: bearerHeaders(value), signal: controller.signal, cache: "no-store" });
        return await checkResponse(key, response, "Cerebras authentication failed");
      case "GROQ_API_KEY":
        response = await fetch("https://api.groq.com/openai/v1/models", { headers: bearerHeaders(value), signal: controller.signal, cache: "no-store" });
        return await checkResponse(key, response, "Groq authentication failed");
      case "KILO_API_KEY":
        response = await fetch("https://api.kilo.ai/api/gateway/chat/completions", { method: "POST", headers: { ...bearerHeaders(value), "content-type": "application/json" }, body: JSON.stringify({ model: "kilo-auto/small", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }), signal: controller.signal, cache: "no-store" });
        return await checkResponse(key, response, "Kilo authentication failed");
      case "COHERE_API_KEY":
        response = await fetch("https://api.cohere.com/v2/models", { headers: bearerHeaders(value), signal: controller.signal, cache: "no-store" });
        return await checkResponse(key, response, "Cohere authentication failed");
      case "CLOUDFLARE_API_TOKEN":
        response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: bearerHeaders(value), signal: controller.signal, cache: "no-store" });
        return await checkResponse(key, response, "Cloudflare token verification failed");
      case "VERCEL_DEPLOY_TOKEN":
        response = await fetch("https://api.vercel.com/v2/user", { headers: bearerHeaders(value), signal: controller.signal, cache: "no-store" });
        return await checkResponse(key, response, "Vercel token authentication failed");
      case "VERCEL_DEPLOY_TEAM_ID":
        return { key, ok: Boolean(value), status: null, message: "Team ID format accepted" };
      case "CLOUDFLARE_ACCOUNT_ID":
        return { key, ok: /^[a-f0-9]{32}$/i.test(value), status: null, message: /^[a-f0-9]{32}$/i.test(value) ? "Account ID looks valid" : "Account ID should be 32 hexadecimal characters" };
      case "OLLAMA_API_KEY":
        response = await fetch("https://ollama.com/api/tags", { headers: bearerHeaders(value), signal: controller.signal, cache: "no-store" });
        return await checkResponse(key, response, "Ollama authentication failed");
      default:
        return { key, ok: false, status: null, message: "Unsupported test" };
    }
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "Connection timed out" : error instanceof Error ? error.message : "Connection failed";
    return { key, ok: false, status: null, message };
  } finally {
    clearTimeout(timer);
  }
}
