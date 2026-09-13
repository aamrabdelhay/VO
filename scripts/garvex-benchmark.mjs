import { readFile } from "node:fs/promises";

const ollamaUrl = process.env.GARVEX_LOCAL_MODEL_URL ?? "http://127.0.0.1:11434";
const model = process.env.GARVEX_LOCAL_MODEL ?? "qwen2.5:7b";
const cases = JSON.parse(await readFile(new URL("./garvex-benchmark-cases.json", import.meta.url), "utf8"));

function check(output, rule) {
  if (rule === "json") {
    try { JSON.parse(output); return true; } catch { return false; }
  }
  if (rule.startsWith("answer:")) {
    try { return String(JSON.parse(output).answer ?? "") === rule.slice(7); } catch { return false; }
  }
  if (rule.startsWith("constraints:")) {
    try {
      const constraints = JSON.parse(output).constraints ?? [];
      return constraints.some((value) => String(value).toLowerCase().includes(rule.slice(12).toLowerCase()));
    } catch { return false; }
  }
  if (rule.startsWith("contains:")) return output.toLowerCase().includes(rule.slice(9).toLowerCase());
  return false;
}

async function ask(prompt) {
  const response = await fetch(`${ollamaUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: "You are the local Garvex candidate. Follow the user's constraints exactly. Do not call external services." },
        { role: "user", content: prompt },
      ],
      options: { temperature: 0 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return String(data?.message?.content ?? "");
}

const started = Date.now();
const results = [];
for (const test of cases) {
  const output = await ask(test.prompt);
  const checks = test.checks.map((rule) => ({ rule, passed: check(output, rule) }));
  const passed = checks.filter((item) => item.passed).length;
  results.push({ id: test.id, score: passed / checks.length, passed, total: checks.length, checks, output: output.slice(0, 4000) });
}

const totalChecks = results.reduce((sum, item) => sum + item.total, 0);
const passedChecks = results.reduce((sum, item) => sum + item.passed, 0);
const score = totalChecks ? passedChecks / totalChecks : 0;
console.log(JSON.stringify({ ok: true, model, score, passedChecks, totalChecks, durationMs: Date.now() - started, results }, null, 2));
if (score < 0.75) process.exitCode = 2;
