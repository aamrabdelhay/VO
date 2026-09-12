"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const PRESETS = [
  { key: "VERCEL_DEPLOY_TOKEN", label: "Vercel Deploy Token", hint: "Used by VO to create deployments and aliases on Vercel." },
  { key: "VERCEL_DEPLOY_TEAM_ID", label: "Vercel Team ID", hint: "Your Vercel team identifier; it is not a secret but is kept here with the hosting configuration." },
  { key: "GITHUB_TOKEN", label: "GitHub Personal Access Token", hint: "Lets Garvex use GitHub API actions for repository inspection and engineering tools." },
  { key: "NVIDIA_API_KEY", label: "NVIDIA API Key", hint: "DeepSeek V4 Flash free endpoint for Garvex and the AI editor." },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API Key", hint: "Multi-model gateway and free-model pool." },
  { key: "MISTRAL_API_KEY", label: "Mistral API Key", hint: "Fast text/coding model provider." },
  { key: "CEREBRAS_API_KEY", label: "Cerebras API Key", hint: "Very fast inference endpoint for parallel agents." },
  { key: "GROQ_API_KEY", label: "Groq API Key", hint: "Very fast inference and speech workloads." },
  { key: "KILO_API_KEY", label: "Kilo API Key", hint: "OpenAI-compatible gateway with Auto Free routing." },
  { key: "COHERE_API_KEY", label: "Cohere API Key", hint: "Useful for multilingual and rerank workloads." },
  { key: "CLOUDFLARE_API_TOKEN", label: "Cloudflare AI Token", hint: "Cloudflare Workers AI / AI Gateway credential." },
  { key: "CLOUDFLARE_ACCOUNT_ID", label: "Cloudflare Account ID", hint: "Required with the Cloudflare API token for account-scoped AI calls." },
  { key: "OLLAMA_API_KEY", label: "Ollama Cloud API Key", hint: "Optional Ollama cloud provider credential." },
];

type Check = { ok: boolean; status: number | null; message: string };

type Meta = { key: string; last_four: string | null; updated_at: string };

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

export function PlatformSecretsForm({ csrf, initial = [] }: { csrf: string; initial?: Meta[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(PRESETS[0].key);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, Check | undefined>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});

  const filtered = useMemo(
    () => PRESETS.filter((item) => `${item.key} ${item.label}`.toLowerCase().includes(search.toLowerCase())).slice(0, 12),
    [search],
  );
  const selectedMeta = PRESETS.find((item) => item.key === selected) ?? PRESETS[0];
  const existing = initial.find((item) => item.key === selected);

  const verify = async (key: string, override?: string) => {
    setChecking((current) => ({ ...current, [key]: true }));
    try {
      const data = await request(
        "/api/v1/admin/secrets",
        { method: "POST", body: JSON.stringify({ key, action: "verify", value: override }) },
        csrf,
      );
      setChecks((current) => ({ ...current, [key]: data.check }));
      return data.check as Check;
    } catch (error) {
      const check = { ok: false, status: null, message: error instanceof Error ? error.message : String(error) };
      setChecks((current) => ({ ...current, [key]: check }));
      return check;
    } finally {
      setChecking((current) => ({ ...current, [key]: false }));
    }
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      for (let i = 0; i < initial.length; i += 3) {
        if (cancelled) return;
        await Promise.all(initial.slice(i, i + 3).map((item) => verify(item.key)));
      }
    };
    if (initial.length) void run();
    return () => { cancelled = true; };
    // The page snapshot is intentionally the dependency: credentials only change through this form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.map((item) => `${item.key}:${item.updated_at}`).join("|")]);

  const choose = (key: string) => {
    setSelected(key);
    setSearch(key);
    setValue("");
    setMessage(null);
  };

  return (
    <div className="p-3.5">
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <div>
          <label className="label" htmlFor="platform-secret-search">API keys & credentials</label>
          <input
            id="platform-secret-search"
            className="input mono"
            placeholder="Search provider or GitHub secret…"
            value={search}
            onChange={(event) => setSearch(event.target.value.toUpperCase())}
          />
          <div className="mt-2 flex flex-col gap-1">
            {filtered.map((item) => {
              const meta = initial.find((entry) => entry.key === item.key);
              const check = checks[item.key];
              const testing = checking[item.key];
              return (
                <button key={item.key} type="button" className="btn justify-start" onClick={() => choose(item.key)}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-label={meta ? (testing ? "Testing" : check?.ok ? "Connected" : check ? "Not working" : "Not tested") : "Not configured"}
                      title={meta ? (testing ? "Testing credential…" : check?.message ?? "Not tested") : "Not configured"}
                      className={testing ? "status-dot status-dot-testing" : meta && check?.ok ? "status-dot status-dot-ok" : meta && check ? "status-dot status-dot-error" : "status-dot status-dot-off"}
                    />
                    <span className="truncate">{item.label}</span>
                  </span>
                  <span className="mono ml-auto text-[10px] opacity-60">{item.key}</span>
                </button>
              );
            })}
          </div>
          <p className="hint mt-3">Green = credential authenticated. Red = the provider rejected it or the connection failed. Gray = not configured.</p>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage(null);
            try {
              const data = await request(
                "/api/v1/admin/secrets",
                { method: "POST", body: JSON.stringify({ key: selected, value }) },
                csrf,
              );
              const check = data.check as Check;
              setValue("");
              setChecks((current) => ({ ...current, [selected]: check }));
              setMessage(check.ok ? "Saved and verified successfully." : `Saved, but verification failed: ${check.message}`);
              router.refresh();
            } catch (error) {
              setMessage(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <label className="label" htmlFor="platform-secret-key">Variable</label>
              <input id="platform-secret-key" className="input mono" value={selected} readOnly />
            </div>
            <span className={checking[selected] ? "status-badge testing" : checks[selected]?.ok ? "status-badge ok" : checks[selected] ? "status-badge error" : "status-badge neutral"}>
              {checking[selected] ? "TESTING…" : checks[selected]?.ok ? "CONNECTED" : checks[selected] ? "NOT WORKING" : existing ? "NOT TESTED" : "NOT CONFIGURED"}
            </span>
          </div>
          <div>
            <label className="label" htmlFor="platform-secret-value">Value</label>
            <input id="platform-secret-value" className="input" type="password" value={value} onChange={(event) => setValue(event.target.value)} required placeholder={existing ? "Enter a new value to replace it" : "Paste credential here"} />
          </div>
          <p className="hint">{selectedMeta.hint}</p>
          {existing ? <p className="hint">Stored securely · ••••{existing.last_four ?? ""} · last updated {new Date(existing.updated_at).toLocaleString()}</p> : null}
          {checks[selected] ? <p className={checks[selected]?.ok ? "hint" : "hint text-red-300"}>{checks[selected]?.message}{checks[selected]?.status ? ` · HTTP ${checks[selected]?.status}` : ""}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving & testing…" : "Save & test"}</button>
            {existing ? <button className="btn" type="button" onClick={() => void verify(selected)} disabled={checking[selected]}>Test current key</button> : null}
            {message ? <span style={{ color: message.startsWith("Saved and verified") ? "var(--color-success)" : "var(--color-danger)", fontSize: 11.5 }}>{message}</span> : null}
          </div>
        </form>
      </div>
    </div>
  );
}
