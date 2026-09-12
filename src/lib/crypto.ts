import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope encryption.
 *
 * A random 256-bit data encryption key (DEK) is generated per secret and
 * encrypted with the platform key encryption key (KEK). Only the wrapped DEK
 * and the ciphertext are persisted, never the plaintext or the raw DEK.
 */
export type Cipher = {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
  dek: { iv: string; tag: string; data: string };
};

function kek(): Buffer {
  const material =
    process.env.PLATFORM_ENCRYPTION_KEY ??
    process.env.DATABASE_URL ??
    "insecure-development-key-material";
  // Deterministic 32 byte key derived from configured material.
  return scryptSync(material, "platform-kek-v1", 32);
}

function gcmEncrypt(key: Buffer, plaintext: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function gcmDecrypt(key: Buffer, parts: { iv: string; tag: string; data: string }) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parts.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(parts.data, "base64")), decipher.final()]);
}

export function encryptSecret(plaintext: string): Cipher {
  const dek = randomBytes(32);
  const payload = gcmEncrypt(dek, Buffer.from(plaintext, "utf8"));
  const wrapped = gcmEncrypt(kek(), dek);
  return { v: 1, alg: "aes-256-gcm", ...payload, dek: wrapped };
}

export function decryptSecret(cipher: unknown): string {
  const c = cipher as Cipher;
  if (!c || c.alg !== "aes-256-gcm") throw new Error("Unsupported cipher payload");
  const dek = gcmDecrypt(kek(), c.dek);
  return gcmDecrypt(dek, { iv: c.iv, tag: c.tag, data: c.data }).toString("utf8");
}

/* ------------------------------------------------------------- passwords */

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

/* ----------------------------------------------------------------- misc */

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time GitHub webhook signature verification (X-Hub-Signature-256). */
export function verifyGithubSignature(secret: string, body: string, signature: string | null) {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Redact secret values from any text destined for logs, UI or AI prompts. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join("«redacted»");
  }
  return out.replace(
    /\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
    "«redacted»",
  );
}
