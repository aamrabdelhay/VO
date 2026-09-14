import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const write = (p, value) => fs.writeFileSync(path.join(root, p), value);

function replaceOnce(file, from, to) {
  const source = read(file);
  if (!source.includes(from)) throw new Error(`Missing anchor in ${file}: ${from.slice(0, 100)}`);
  write(file, source.replace(from, to));
}

replaceOnce("src/lib/queue.ts", "  | \"domain-verify\";", "  | \"domain-verify\"\n  | \"memory-extract\";");

replaceOnce("src/db/schema.ts", "  pgEnum,\n  doublePrecision,\n} from \"drizzle-orm/pg-core\";", "  pgEnum,\n  doublePrecision,\n  customType,\n} from \"drizzle-orm/pg-core\";");
replaceOnce("src/db/schema.ts", "const updatedAt = () => timestamp(\"updated_at\", { withTimezone: true }).notNull().defaultNow();", "const updatedAt = () => timestamp(\"updated_at\", { withTimezone: true }).notNull().defaultNow();\n\nconst vector1536 = customType<{ data: number[]; driverData: string }>({\n  dataType: () => \"vector(1536)\",\n  toDriver: (value) => `[${value.join(\",\")}]`,\n  fromDriver: (value) => String(value).slice(1, -1).split(\",\").filter(Boolean).map(Number),\n});");
replaceOnce("src/db/schema.ts", "export const aiToolCalls = pgTable(\"ai_tool_calls\", {", `export const garvexMemories = pgTable(\n  "garvex_memories",\n  {\n    id: id(),\n    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),\n    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),\n    content: text("content").notNull(),\n    embedding: vector1536("embedding").notNull(),\n    sourceConversationId: text("source_conversation_id").references(() => aiConversations.id, { onDelete: "set null" }),\n    createdAt: createdAt(),\n    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),\n    useCount: integer("use_count").notNull().default(0),\n  },\n  (t) => [index("garvex_memories_scope_idx").on(t.orgId, t.projectId), index("garvex_memories_last_used_idx").on(t.lastUsedAt)],\n);\n\nexport const aiToolCalls = pgTable("ai_tool_calls", {`);

replaceOnce("scripts/prepare-vercel-db.mjs", '  await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS free_domain text`);', '  await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);\n  await client.query(`CREATE TABLE IF NOT EXISTS garvex_memories (id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id text REFERENCES projects(id) ON DELETE CASCADE, content text NOT NULL, embedding vector(1536) NOT NULL, source_conversation_id text REFERENCES ai_conversations(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, use_count integer NOT NULL DEFAULT 0)`);\n  await client.query(`CREATE INDEX IF NOT EXISTS garvex_memories_scope_idx ON garvex_memories(org_id, project_id)`);\n  await client.query(`CREATE INDEX IF NOT EXISTS garvex_memories_last_used_idx ON garvex_memories(last_used_at)`);\n  await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS free_domain text`);');

console.log("schema migration prepared");
