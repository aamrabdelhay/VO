import { asc, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { deploymentLogChunks } from "@/db/schema";
import { registerArtifact, storage, daysFromNow } from "@/lib/storage";
import { redact } from "@/lib/crypto";

const MAX_LIVE_CHUNKS = 800;

type Sink = (line: string) => void;
const subscribers = new Map<string, Set<Sink>>();

export function subscribe(deploymentId: string, sink: Sink) {
  const set = subscribers.get(deploymentId) ?? new Set<Sink>();
  set.add(sink);
  subscribers.set(deploymentId, set);
  return () => {
    set.delete(sink);
    if (set.size === 0) subscribers.delete(deploymentId);
  };
}

/**
 * Bounded live log tail in Postgres (for streaming + UI); the complete log is
 * flushed to object storage at the end of the deployment.
 */
export class DeploymentLogger {
  private seq = 0;
  private buffer: string[] = [];

  constructor(
    private readonly deploymentId: string,
    private readonly projectId: string,
    private readonly secrets: string[] = [],
  ) {}

  async write(content: string, stream = "build", level: "info" | "warn" | "error" = "info") {
    const clean = redact(content, this.secrets).replace(/\u0000/g, "");
    for (const line of clean.split("\n")) {
      if (!line.trim()) continue;
      const stamped = `${new Date().toISOString()} ${line}`;
      this.buffer.push(stamped);
      this.seq += 1;
      await db.insert(deploymentLogChunks).values({
        deploymentId: this.deploymentId,
        seq: this.seq,
        stream,
        level,
        content: line.slice(0, 8000),
      });
      const subs = subscribers.get(this.deploymentId);
      if (subs) for (const s of subs) s(stamped);
    }
    if (this.seq % 200 === 0) await this.trim();
  }

  private async trim() {
    const cutoff = this.seq - MAX_LIVE_CHUNKS;
    if (cutoff > 0) {
      await db
        .delete(deploymentLogChunks)
        .where(
          sql`${deploymentLogChunks.deploymentId} = ${this.deploymentId} and ${deploymentLogChunks.seq} < ${cutoff}`,
        );
    }
  }

  /** Persist the full log to durable object storage and register the artifact. */
  async flush(retentionDays: number) {
    if (this.buffer.length === 0) return null;
    const key = `logs/${this.projectId}/${this.deploymentId}.log`;
    const { size, checksum } = await storage.put(key, this.buffer.join("\n"));
    await registerArtifact({
      projectId: this.projectId,
      deploymentId: this.deploymentId,
      type: "LOG",
      storageKey: key,
      sizeBytes: size,
      checksum,
      expiresAt: daysFromNow(retentionDays),
    });
    return key;
  }
}

export async function readLiveLogs(deploymentId: string, afterSeq = 0) {
  return db
    .select()
    .from(deploymentLogChunks)
    .where(
      sql`${deploymentLogChunks.deploymentId} = ${deploymentId} and ${deploymentLogChunks.seq} > ${afterSeq}`,
    )
    .orderBy(asc(deploymentLogChunks.seq))
    .limit(1000);
}

export async function purgeLogChunksBefore(date: Date) {
  const deleted = await db
    .delete(deploymentLogChunks)
    .where(lt(deploymentLogChunks.createdAt, date))
    .returning({ id: deploymentLogChunks.id });
  return deleted.length;
}

export async function deleteLogChunks(deploymentId: string) {
  await db.delete(deploymentLogChunks).where(eq(deploymentLogChunks.deploymentId, deploymentId));
}
