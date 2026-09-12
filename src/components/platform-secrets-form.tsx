"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const PRESETS = [
  { key: "VERCEL_DEPLOY_TOKEN", label: "Vercel Deploy Token", hint: "Used by VO to create deployments and aliases on Vercel." },
  { key: "VERCEL_DEPLOY_TEAM_ID", label: "Vercel Team ID", hint: "Your Vercel team identifier; it is not a secret but is kept here with the hosting configuration." },
  { key: "GITHUB_TOKEN", label: "GitHub Personal Access Token", hint: "Lets Garvex use GitHub API actions for repository inspection and future engineering tools." },
  { key: "NVIDIA_API_KEY", label: "NVIDIA API Key", hint: "DeepSeek V4 Flash free endpoint for Garvex and the existing AI editor." },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API Key", hint: "Multi-model gateway and free-model pool." },
  { key: "MISTRAL_API_KEY", label: "Mistral API Key", hint: "Fast text/coding model provider; free mode has usage limits." },
  { key: "CEREBRAS_API_KEY", label: "Cerebras API Key", hint: "Very fast inference endpoint for parallel agent workers." },
  { key: "GROQ_API_KEY", label: "Groq API Key", hint: "Very fast inference plus speech models available on GroqCloud." },
  { key: "KILO_API_KEY", label: "Kilo API Key", hint: "Gateway with Auto Free and many coding models." },
  { key: "COHERE_API_KEY", label: "Cohere API Key", hint: "Useful for multilingual/enterprise text and rerank workloads." },
  { key: "CLOUDFLARE_API_TOKEN", label: "Cloudflare AI Token", hint: "Cloudflare Workers AI / AI Gateway credential." },
  { key: "CLOUDFLARE_ACCOUNT_ID", label: "Cloudflare Account ID", hint: "Required with the Cloudflare API token for account-scoped AI calls." },
  { key: "OLLAMA_API_KEY", label: "Ollama Cloud API Key", hint: "Optional Ollama cloud provider credential." },
];

async function request(path: string, options: RequestInit, csrf: string) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", "x-csrf-token": csrf, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status})`);
  return data.data;
}

export function PlatformSecretsForm({ csrf, initial = [] }: { csrf: string; initial?: { key: string; last_four: string | null; updated_at: string }[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(PRESETS[0].key);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const filtered = useMemo(() => PRESETS.filter((item) => `${item.key} ${item.label}`.toLowerCase().includes(search.toLowerCase())).slice(0, 12), [search]);
  const selectedMeta = PRESETS.find((item) => item.key === selected) ?? PRESETS[0];
  const existing = initial.find((item) => item.key === selected);

  const choose = (key: string) => {
    setSelected(key);
    setSearch(key);
    setValue("");
    setMessage(null);
  };

  return (
    <div className="p-3.5">
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div>
          <label className="label" htmlFor="platform-secret-search">Quick add / search</label>
          <input
            id="platform-secret-search"
            className="input mono"
            placeholder="Search provider or GitHub secret…"
            value={search}
            onChange={(event) => setSearch(event.target.value.toUpperCase())}
          />
          <div className="mt-2 flex flex-col gap-1">
            {filtered.map((item) => (
              <button key={item.key} type="button" className="btn justify-start" onClick={() => choose(item.key)}>
                <span>{item.label}</span><span className="mono ml-auto text-[10px] opacity-60">{item.key}</span>
              </button>
            ))}
          </div>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage(null);
            try {
              await request("/api/v1/admin/secrets", {
                method: "POST",
                body: JSON.stringify({ key: selected, value }),
              }, csrf);
              setValue("");
              setMessage("Saved securely. The plaintext value is never displayed again.");
              router.refresh();
            } catch (error) {
              setMessage(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div>
            <label className="label" htmlFor="platform-secret-key">Variable</label>
            <input id="platform-secret-key" className="input mono" value={selected} readOnly />
          </div>
          <div>
            <label className="label" htmlFor="platform-secret-value">Value</label>
            <input id="platform-secret-value" className="input" type="password" value={value} onChange={(event) => setValue(event.target.value)} required />
          </div>
          <p className="hint">{selectedMeta.hint}</p>
          {existing ? <p className="hint">Configured · last characters: ••••{existing.last_four ?? ""}</p> : null}
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save secret"}</button>
            {message ? <span style={{ color: message.startsWith("Saved") ? "var(--color-success)" : "var(--color-danger)", fontSize: 11.5 }}>{message}</span> : null}
          </div>
        </form>
      </div>
    </div>
  );
}
