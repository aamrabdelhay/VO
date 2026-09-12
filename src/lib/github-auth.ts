import { createSign } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { githubInstallations } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { log } from "@/lib/logger";

type CachedToken = { token: string; expiresAt: number };
const cache = new Map<string, CachedToken>();

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

/** GitHub App JWT (RS256), signed with the app private key held server-side only. */
export function appJwt(): string | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!appId || !privateKey) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

async function mintInstallationToken(installationId: string): Promise<string | null> {
  const jwt = appJwt();
  if (!jwt) return null;
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "self-hosted-deploy-platform",
      },
    },
  );
  if (!res.ok) {
    log.warn("Installation token request failed", { status: res.status });
    return null;
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  cache.set(installationId, {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime() - 60_000,
  });
  return data.token;
}

/**
 * Resolves a short-lived credential for repository access.
 * Order: GitHub App installation token → stored org PAT → platform env token.
 * Public repositories work with no credential at all.
 */
export async function installationToken(orgId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.orgId, orgId))
    .limit(1);
  const installation = rows[0];
  if (installation) {
    const cached = cache.get(installation.installationId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const minted = await mintInstallationToken(installation.installationId);
    if (minted) return minted;
    if (installation.tokenCipher) {
      try {
        return decryptSecret(installation.tokenCipher);
      } catch {
        return null;
      }
    }
  }
  return process.env.GITHUB_TOKEN ?? null;
}
