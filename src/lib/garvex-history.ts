import { sql } from "drizzle-orm";
import { db } from "@/db";

export type GarvexHistoryMessage = { role: "user" | "assistant"; content: string; mode?: "chat" | "build" | "research" };
export type GarvexHistoryItem = { id: string; title: string; projectId: string | null; createdAt: string; updatedAt: string; messageCount: number };

let tableReady: Promise<void> | null = null;

async function ensureTable() {
  if (!tableReady) {
    tableReady = (async () => {
      await db.execute(sql`create table if not exists garvex_chats (id text primary key, user_id text not null references users(id) on delete cascade, project_id text, title text not null, messages jsonb not null default '[]'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
      await db.execute(sql`create index if not exists garvex_chats_user_updated_idx on garvex_chats(user_id, updated_at desc)`);
    })().catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

export async function listGarvexChats(userId: string): Promise<GarvexHistoryItem[]> {
  await ensureTable();
  const result = await db.execute<{ id: string; title: string; projectId: string | null; messageCount: number | string; createdAt: string; updatedAt: string }>(sql`
    select id, title, project_id as "projectId", created_at as "createdAt", updated_at as "updatedAt", jsonb_array_length(messages) as "messageCount"
    from garvex_chats where user_id=${userId} order by updated_at desc limit 100
  `);
  return (result.rows ?? []).map((row) => ({ id: row.id, title: row.title, projectId: row.projectId, createdAt: row.createdAt, updatedAt: row.updatedAt, messageCount: Number(row.messageCount ?? 0) }));
}

export async function getGarvexChat(userId: string, id: string) {
  await ensureTable();
  const result = await db.execute<{ id: string; title: string; project_id: string | null; messages: unknown; created_at: string; updated_at: string }>(sql`
    select id,title,project_id,messages,created_at,updated_at from garvex_chats where id=${id} and user_id=${userId} limit 1
  `);
  const row = result.rows?.[0];
  if (!row) return null;
  const messages = Array.isArray(row.messages) ? row.messages : [];
  return { id: row.id, title: row.title, projectId: row.project_id, messages: messages as GarvexHistoryMessage[], createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function saveGarvexChat(input: { id?: string; userId: string; projectId?: string | null; title: string; messages: GarvexHistoryMessage[] }) {
  await ensureTable();
  const id = input.id || crypto.randomUUID();
  const title = input.title.trim().slice(0, 160) || "New Garvex chat";
  const messages = input.messages.slice(-120).map((message) => ({ role: message.role, content: message.content.slice(0, 20000), mode: message.mode }));
  await db.execute(sql`
    insert into garvex_chats (id,user_id,project_id,title,messages,created_at,updated_at)
    values (${id},${input.userId},${input.projectId ?? null},${title},${JSON.stringify(messages)}::jsonb,now(),now())
    on conflict (id) do update set project_id=excluded.project_id,title=excluded.title,messages=excluded.messages,updated_at=now()
  `);
  return id;
}

export async function deleteGarvexChat(userId: string, id?: string) {
  await ensureTable();
  if (id) await db.execute(sql`delete from garvex_chats where id=${id} and user_id=${userId}`);
  else await db.execute(sql`delete from garvex_chats where user_id=${userId}`);
}
