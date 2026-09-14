import fs from "node:fs";
import path from "node:path";
const file = path.join(process.cwd(), "src/components/garvex-chat-v4.tsx");
let source = fs.readFileSync(file, "utf8");
const from = 'body: JSON.stringify({ prompt: text, mode, history: messages.slice(-10).map((item) => ({ role: item.role, content: item.content })), context:';
const to = 'body: JSON.stringify({ prompt: text, mode, conversationId: historyId ?? undefined, projectId: selectedProjectId || undefined, history: messages.slice(-10).map((item) => ({ role: item.role, content: item.content })), context:';
if (!source.includes(from)) throw new Error("Research request anchor not found");
source = source.replace(from, to);
fs.writeFileSync(file, source);
