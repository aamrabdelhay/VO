import http from "node:http";

const host = process.env.GARVEX_HOST ?? "127.0.0.1";
const port = Number(process.env.GARVEX_PORT ?? 11435);
const ollamaUrl = process.env.GARVEX_LOCAL_MODEL_URL ?? "http://127.0.0.1:11434";
const model = process.env.GARVEX_LOCAL_MODEL ?? "qwen2.5:7b";

async function ask(messages) {
  const response = await fetch(`${ollamaUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: "You are Garvex Local. Work only through the supplied conversation. Do not use external AI APIs. Preserve existing project behavior. Never claim an action was completed unless the supplied tools or evidence show it was completed." },
        ...messages,
      ],
      options: { temperature: 0.2 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return { role: "assistant", content: String(data?.message?.content ?? "") };
}

const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.method === "GET" && request.url === "/health") {
    response.end(JSON.stringify({ ok: true, model, ollamaUrl }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/chat") {
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error: "Not found" }));
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error("messages must be a non-empty array");
    const answer = await ask(body.messages);
    response.end(JSON.stringify({ ok: true, model, ...answer }));
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ ok: false, error: String(error) }));
  }
});

server.listen(port, host, () => console.log(`Garvex Local listening on http://${host}:${port}`));
