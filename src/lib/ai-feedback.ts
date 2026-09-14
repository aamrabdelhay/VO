import { sql } from "drizzle-orm";
import { db } from "@/db";

let ready: Promise<void> | null = null;
async function ensureTable() {
  if (!ready) {
    ready = db.execute(sql`
      create table if not exists ai_feedback (
        id text primary key,
        message_id text not null,
        user_id text not null references users(id) on delete cascade,
        rating text not null check (rating in ('up','down')),
        note text,
        created_at timestamptz not null default now(),
        unique(message_id, user_id)
      )
    `).then(() => undefined).catch((error) => { ready = null; throw error; });
  }
  return ready;
}

export async function saveAIFeedback(input: { messageId: string; userId: string; rating: "up" | "down"; note?: string | null }) {
  await ensureTable();
  await db.execute(sql`
    insert into ai_feedback (id,message_id,user_id,rating,note)
    values (${crypto.randomUUID()},${input.messageId},${input.userId},${input.rating},${input.note?.slice(0,1000) ?? null})
    on conflict (message_id,user_id) do update set rating=excluded.rating,note=excluded.note,created_at=now()
  `);
}
