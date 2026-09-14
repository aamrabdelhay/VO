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
replaceOnce("src/lib/worker.ts", 'import { transition } from "@/lib/state-machine";', 'import { transition } from "@/lib/state-machine";\nimport { extractMemories } from "@/lib/ai/memory";');
replaceOnce("src/lib/worker.ts", '  "domain-verify": async (payload) => verifyDomain(String(payload.domainId)), "ai-diagnose":', '  "domain-verify": async (payload) => verifyDomain(String(payload.domainId)),\n  "memory-extract": async (payload) => extractMemories(String(payload.conversationId)),\n  "ai-diagnose":');
replaceOnce("src/lib/cleanup.ts", '  notifications,\n} from "@/db/schema";', '  notifications,\n} from "@/db/schema";\nimport { cleanupMemories } from "@/lib/ai/memory";');
replaceOnce("src/lib/cleanup.ts", '  const results: CleanupSummary[] = [];\n  for (const fn of [cleanupWorkspaces, cleanupPreviews, cleanupContainers, cleanupArtifacts, cleanupLogs]) {', '  const results: CleanupSummary[] = [];\n  try {\n    const deleted = await cleanupMemories();\n    results.push({ kind: "garvex-memories", scanned: deleted, deleted, skipped: 0, bytesReclaimed: 0, detail: { retentionDays: Number(process.env.GARVEX_MEMORY_RETENTION_DAYS ?? 180) } });\n  } catch (error) {\n    log.error("Garvex memory cleanup failed", { error: String(error) });\n  }\n  for (const fn of [cleanupWorkspaces, cleanupPreviews, cleanupContainers, cleanupArtifacts, cleanupLogs]) {');
replaceOnce("src/lib/platform-secrets.ts", '"OLLAMA_API_KEY","GITHUB_TOKEN"', '"OLLAMA_API_KEY","SEARCH_API_KEY","GITHUB_TOKEN"');
replaceOnce("src/lib/platform-secrets.ts", '    case "OLLAMA_API_KEY": response=await fetch("https://ollama.com/api/tags",{headers:bearerHeaders(value),signal:controller.signal,cache:"no-store"});return checkResponse(key,response,"Ollama authentication failed");', '    case "OLLAMA_API_KEY": response=await fetch("https://ollama.com/api/tags",{headers:bearerHeaders(value),signal:controller.signal,cache:"no-store"});return checkResponse(key,response,"Ollama authentication failed");\n    case "SEARCH_API_KEY": response=await fetch("https://api.search.brave.com/res/v1/web/search?q=VO",{headers:{accept:"application/json","x-subscription-token":value,"user-agent":"vo-platform"},signal:controller.signal,cache:"no-store"});return checkResponse(key,response,"Search API authentication failed");');

// Make memory-aware persistence part of the existing agent.ask path.
replaceOnce("src/lib/ai/agent.ts", 'import { redact } from "@/lib/crypto";', 'import { redact } from "@/lib/crypto";\nimport { retrieveRelevantMemories } from "@/lib/ai/memory";\nimport { enqueue } from "@/lib/queue";');
replaceOnce("src/lib/ai/agent.ts", '  const provider = providerFor(config.provider);\n  const result = await provider.complete(messages, config);', '  const query = [...messages].reverse().find((message) => message.role === "user");\n  const [conversation] = await db.select({ projectId: aiConversations.projectId }).from(aiConversations).where(eq(aiConversations.id, conversationId)).limit(1);\n  let effectiveMessages = messages;\n  if (query && conversation) {\n    const [project] = await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, conversation.projectId)).limit(1);\n    if (project) {\n      const memories = await retrieveRelevantMemories(project.orgId, conversation.projectId, textContentForMemory(query.content));\n      if (memories.length) {\n        const context = "Known context from prior conversations (may be outdated — verify before relying on it for anything time-sensitive):\\n" + memories.map((memory) => `- ${memory.content}`).join("\\n");\n        effectiveMessages = messages.map((message, index) => index === 0 && message.role === "system" ? { ...message, content: `${textContentForMemory(message.content)}\\n\\n${context}` } : message);\n      }\n    }\n  }\n  const provider = providerFor(config.provider);\n  const result = await provider.complete(effectiveMessages, config);');
replaceOnce("src/lib/ai/agent.ts", '      content: message.content.slice(0, 20000),', '      content: textContentForMemory(message.content).slice(0, 20000),');
replaceOnce("src/lib/ai/agent.ts", '  });\n  return result;\n}\n\nfunction parseJsonBlock', '  });\n  void enqueue({ type: "memory-extract", payload: { conversationId }, dedupeKey: `memory-extract:${conversationId}:${Date.now()}` }).catch(() => undefined);\n  return result;\n}\n\nfunction textContentForMemory(content: ChatMessage["content"]) {\n  return typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\\n");\n}\n\nfunction parseJsonBlock');

console.log("memory queue and cleanup wiring prepared");
