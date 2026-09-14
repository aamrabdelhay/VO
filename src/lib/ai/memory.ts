import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiConversations, aiMessages, garvexMemories, projects } from "@/db/schema";
import { providerFor, resolveAIConfig, type ChatMessage } from "@/lib/ai/provider";
import { getPlatformSecret } from "@/lib/platform-secrets";

const RETENTION_DAYS = Math.max(1, Number(process.env.GARVEX_MEMORY_RETENTION_DAYS ?? 180));
const RETENTION_MIN_USES = Math.max(0, Number(process.env.GARVEX_MEMORY_RETENTION_MIN_USES ?? 1));
const SIMILARITY_THRESHOLD = Math.min(0.99, Math.max(0.5, Number(process.env.GARVEX_MEMORY_SIMILARITY_THRESHOLD ?? 0.78)));

function parseJsonArray(text: string): string[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const value: unknown = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

export async function embed(text: string): Promise<number[] | null> {
  const openRouter = (await getPlatformSecret("OPENROUTER_API_KEY")) ?? process.env.OPENROUTER_API_KEY ?? null;
  const openAi = process.env.OPENAI_API_KEY ?? null;
  const key = openRouter ?? openAi;
  if (!key) return null;
  const base = openRouter ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1";
  const model = openRouter ? "openai/text-embedding-3-small" : "text-embedding-3-small";
  const response = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: text.slice(0, 8000) }),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { data?: { embedding?: number[] }[] };
  const vector = data.data?.[0]?.embedding;
  return vector?.length === 1536 ? vector : null;
}

export async function extractMemories(conversationId: string) {
  const [row] = await db
    .select({ conversation: aiConversations, project: projects })
    .from(aiConversations)
    .innerJoin(projects, eq(projects.id, aiConversations.projectId))
    .where(eq(aiConversations.id, conversationId))
    .limit(1);
  if (!row) return 0;

  const messages = await db
    .select({ role: aiMessages.role, content: aiMessages.content })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(sql`${aiMessages.createdAt} desc`)
    .limit(4);
  if (messages.length < 2) return 0;

  const exchange = messages.reverse().map((message) => `${message.role}: ${message.content.slice(0, 6000)}`).join("\n\n");
  const config = await resolveAIConfig(row.project.orgId);
  if (!config) return 0;

  const messagesForExtraction: ChatMessage[] = [
    {
      role: "system",
      content: "Extract only durable, atomic facts worth remembering. Output ONLY a JSON array of short strings, or []. Keep stable preferences, recurring constraints, and durable project facts. Never store passwords, API keys, secrets, credentials, speculative claims, transient tasks, one-off debugging state, or sensitive personal information.",
    },
    { role: "user", content: exchange },
  ];
  const result = await providerFor(config.provider).complete(messagesForExtraction, config);
  const facts = parseJsonArray(result.text);
  let stored = 0;
  for (const content of facts) {
    const embedding = await embed(content);
    if (!embedding) continue;
    await db.insert(garvexMemories).values({
      orgId: row.project.orgId,
      projectId: row.project.id,
      content,
      embedding,
      sourceConversationId: conversationId,
    });
    stored += 1;
  }
  return stored;
}

export async function retrieveRelevantMemories(orgId: string, projectId: string | null, queryText: string, limit = 6) {
  const embedding = await embed(queryText);
  if (!embedding) return [];
  const vector = `[${embedding.join(",")}]`;
  const rows = await db.execute<{ id: string; content: string; similarity: number }>(sql`
    select id, content, 1 - (embedding <=> ${vector}::vector) as similarity
    from garvex_memories
    where org_id = ${orgId}
      and (${projectId} is null or project_id is null or project_id = ${projectId})
    order by embedding <=> ${vector}::vector
    limit ${Math.min(12, Math.max(1, limit))}
  `);
  const relevant = (rows.rows ?? []).filter((row) => Number(row.similarity) >= SIMILARITY_THRESHOLD).slice(0, limit);
  if (!relevant.length) return [];
  const ids = relevant.map((row) => row.id);
  await db.execute(sql`update garvex_memories set last_used_at = now(), use_count = use_count + 1 where id in (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`);
  return relevant;
}

export async function cleanupMemories() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  const deleted = await db.execute(sql`
    delete from garvex_memories
    where coalesce(last_used_at, created_at) < ${cutoff}
      and use_count < ${RETENTION_MIN_USES}
    returning id
  `);
  return deleted.rows?.length ?? 0;
}
