"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const PRESETS = [
  ["DATABASE_URL", "PostgreSQL connection string"],
  ["NVIDIA_API_KEY", "NVIDIA Build API key"],
  ["VERCEL_DEPLOY_TOKEN", "Vercel deployment token"],
  ["VERCEL_DEPLOY_TEAM_ID", "Vercel team id"],
  ["OPENAI_API_KEY", "OpenAI API key"],
  ["ANTHROPIC_API_KEY", "Anthropic API key"],
  ["GEMINI_API_KEY", "Gemini API key"],
  ["NEXTAUTH_SECRET", "NextAuth secret"],
  ["JWT_SECRET", "JWT signing secret"],
  ["STRIPE_SECRET_KEY", "Stripe secret key"],
  ["STRIPE_PUBLISHABLE_KEY", "Stripe publishable key"],
];

async function send(path: string, csrf: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data.data;
}

export function EnvSmartForm({ csrf, projectId }: { csrf: string; projectId: string }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState("PRODUCTION");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filtered = PRESETS.filter(([name, label]) => `${name} ${label}`.toLowerCase().includes(query.toLowerCase()));

  const choose = (nextKey: string) => {
    setKey(nextKey);
    setQuery(nextKey);
    setError(null);
  };

  return (
    <div className="p-3.5">
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div>
          <label className="label" htmlFor="env-search">Quick add / search</label>
          <input id="env-search" className="input mono" placeholder="Type or search a variable name" value={query} onChange={(e) => { setQuery(e.target.value); setKey(e.target.value.toUpperCase()); }} />
          <div className="mt-2 max-h-72 overflow-y-auto border rounded-md">
            {filtered.map(([name, label]) => (
              <button key={name} type="button" className="flex w-full items-center justify-between px-3 py-2 text-left border-b last:border-b-0 hover:bg-white/5" onClick={() => choose(name)}>
                <span className="mono text-[11px]">{name}</span>
                <span className="hint ml-3">{label}</span>
              </button>
            ))}
            {filtered.length === 0 ? <div className="p-3 hint">No preset — you can still type a custom key.</div> : null}
          </div>
        </div>
        <form className="flex flex-col gap-3" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setError(null);
          try {
            await send(`/api/v1/projects/${projectId}/env`, csrf, { key: key.trim().toUpperCase(), value, scope });
            setValue(""); router.refresh();
          } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
          finally { setBusy(false); }
        }}>
          <div>
            <label className="label" htmlFor="env-smart-key">Variable name</label>
            <input id="env-smart-key" className="input mono" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} pattern="[A-Za-z_][A-Za-z0-9_]*" required />
          </div>
          <div>
            <label className="label" htmlFor="env-smart-value">Value</label>
            <input id="env-smart-value" className="input" type="password" value={value} onChange={(e) => setValue(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="env-smart-scope">Scope</label>
            <select id="env-smart-scope" className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option>PRODUCTION</option><option>PREVIEW</option><option>DEVELOPMENT</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Add variable"}</button>
            {error ? <span style={{ color: "var(--color-danger)", fontSize: 11.5 }}>{error}</span> : null}
          </div>
        </form>
      </div>
    </div>
  );
}
