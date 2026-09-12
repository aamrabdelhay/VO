import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { deploymentArtifacts } from "@/db/schema";

/**
 * Object storage abstraction. The filesystem driver is used for self-hosted
 * single-node installs; the same interface maps onto S3/MinIO by swapping the
 * driver (STORAGE_DRIVER=s3 with STORAGE_ENDPOINT credentials).
 */
export interface ObjectStore {
  put(key: string, body: Buffer | string): Promise<{ size: number; checksum: string }>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<number>;
  size(key: string): Promise<number>;
  list(prefix: string): Promise<string[]>;
}

export const STORAGE_ROOT =
  process.env.PLATFORM_STORAGE_ROOT ?? path.join(process.cwd(), ".platform", "storage");

function resolveKey(key: string) {
  const normalized = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(STORAGE_ROOT, normalized);
  // Path traversal guard.
  if (!full.startsWith(STORAGE_ROOT)) throw new Error("Invalid storage key");
  return full;
}

class FileObjectStore implements ObjectStore {
  async put(key: string, body: Buffer | string) {
    const full = resolveKey(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    await fs.writeFile(full, buf);
    return { size: buf.byteLength, checksum: createHash("sha256").update(buf).digest("hex") };
  }
  async get(key: string) {
    try {
      return await fs.readFile(resolveKey(key));
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    const full = resolveKey(key);
    try {
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        const size = await dirSize(full);
        await fs.rm(full, { recursive: true, force: true });
        return size;
      }
      await fs.rm(full, { force: true });
      return stat.size;
    } catch {
      return 0;
    }
  }
  async size(key: string) {
    try {
      const stat = await fs.stat(resolveKey(key));
      return stat.isDirectory() ? dirSize(resolveKey(key)) : stat.size;
    } catch {
      return 0;
    }
  }
  async list(prefix: string) {
    const full = resolveKey(prefix);
    try {
      const entries = await fs.readdir(full, { withFileTypes: true, recursive: true });
      return entries.filter((e) => e.isFile()).map((e) => path.join(prefix, e.name));
    } catch {
      return [];
    }
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else {
      const s = await fs.stat(p).catch(() => null);
      total += s?.size ?? 0;
    }
  }
  return total;
}

export const storage: ObjectStore = new FileObjectStore();

export async function registerArtifact(input: {
  projectId: string;
  deploymentId?: string | null;
  type: "IMAGE" | "BUNDLE" | "STATIC" | "LOG" | "CACHE" | "REPORT";
  storageKey: string;
  sizeBytes: number;
  checksum?: string | null;
  expiresAt?: Date | null;
}) {
  const [row] = await db
    .insert(deploymentArtifacts)
    .values({
      projectId: input.projectId,
      deploymentId: input.deploymentId ?? null,
      type: input.type,
      storageKey: input.storageKey,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: deploymentArtifacts.storageKey,
      set: { sizeBytes: input.sizeBytes, checksum: input.checksum ?? null },
    })
    .returning();
  return row;
}

export async function liveArtifacts(projectId: string) {
  return db
    .select()
    .from(deploymentArtifacts)
    .where(and(eq(deploymentArtifacts.projectId, projectId), isNull(deploymentArtifacts.deletedAt)));
}

export function daysFromNow(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
