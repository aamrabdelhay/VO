"use client";

import { useEffect, useMemo, useState } from "react";

const PRESETS = [
  { key: "VERCEL_DEPLOY_TOKEN", label: "Vercel Deploy Token", hint: "Used by VO to create deployments and aliases on Vercel." },
  { key: "VERCEL_DEPLOY_TEAM_ID", label: "Vercel Team ID", hint: "Vercel team identifier." },
  { key: "GITHUB_TOKEN", label: "GitHub Personal Access Token", hint: "Lets Garvex inspect repositories and perform approved GitHub engineering actions." },
  { key: "NVIDIA_API_KEY", label: "NVIDIA API Key", hint: "NVIDIA inference credential for Garvex." },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API Key", hint: "Multi-model gateway and free-model pool." },
  { key: "MISTRAL_API_KEY", label: "Mistral API Key", hint: "Fast text/coding provider." },
  { key: "CEREBRAS_API_KEY", label: "Cerebras API Key", hint: "Fast inference provider." },
  { key: "GROQ_API_KEY", label: "Groq API Key", hint: "Fast inference and speech workloads." },
  { key: "KILO_API_KEY", label: "Kilo API Key", hint: "OpenAI-compatible coding gateway." },
  { key: "COHERE_API_KEY", label: "Cohere API Key", hint: "Multilingual and rerank workloads." },
  { key: "CLOUDFLARE_API_TOKEN", label: "Cloudflare API Token", hint: "Cloudflare account/API credential." },
  { key: "CLOUDFLARE_ACCOUNT_ID", label: "Cloudflare Account ID", hint: "32-character Cloudflare account identifier." },
  { key: "OLLAMA_API_KEY", label: "Ollama Cloud API Key", hint: "Optional Ollama cloud credential." },
] as const;

type Check = { ok: boolean; status: number | null; message: string };
type Meta = { id: string; key: string; last_four: string | null; updated_at: string };

async function request(path: string, options: RequestInit, csrf: string) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", "x-csrf-token": csrf, ...(options.headers ?? {}) } });
  const text = await response.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Invalid server response (${response.status})`); }
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status})`);
  return data.data;
}

export function PlatformSecretsForm({ csrf, initial = [] }: { csrf: string; initial?: Meta[] }) {
  const [secrets, setSecrets] = useState<Meta[]>(initial);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<(typeof PRESETS)[number]["key"]>("NVIDIA_API_KEY");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { setSecrets(initial); }, [initial]);

  const refreshSecrets = async () => {
    const data = await request("/api/v1/admin/secrets", { method: "GET" }, csrf);
    setSecrets((data.secrets ?? []) as Meta[]);
  };
  const filtered = useMemo(() => PRESETS.filter((item) => `${item.key} ${item.label}`.toLowerCase().includes(search.toLowerCase())), [search]);
  const selectedMeta = PRESETS.find((item) => item.key === selected) ?? PRESETS[0];
  const entries = secrets.filter((item) => item.key === selected);

  const verify = async (id: string) => {
    setChecking((current) => ({ ...current, [id]: true }));
    try {
      const data = await request("/api/v1/admin/secrets", { method: "POST", body: JSON.stringify({ action: "verify", id }) }, csrf);
      setChecks((current) => ({ ...current, [id]: data.check as Check }));
    } catch (error) {
      setChecks((current) => ({ ...current, [id]: { ok: false, status: null, message: error instanceof Error ? error.message : String(error) } }));
    } finally { setChecking((current) => ({ ...current, [id]: false })); }
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      for (let i = 0; i < secrets.length; i += 3) {
        if (cancelled) return;
        await Promise.all(secrets.slice(i, i + 3).map((entry) => verify(entry.id)));
      }
    };
    if (secrets.length) void run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secrets.map((item) => `${item.id}:${item.updated_at}`).join("|")]);

  const choose = (key: (typeof PRESETS)[number]["key"]) => { setSelected(key); setSearch(key); setValue(""); setNotice(null); };

  return (
    <div className="p-3.5">
      <div className="grid gap-4 lg:grid-cols-[350px_1fr]">
        <div>
          <label className="label" htmlFor="platform-secret-search">Providers & credentials</label>
          <input id="platform-secret-search" className="input mono" placeholder="Search provider…" value={search} onChange={(event) => setSearch(event.target.value.toUpperCase())} />
          <div className="mt-2 flex max-h-[520px] flex-col gap-1 overflow-auto pr-1">
            {filtered.map((item) => {
              const providerEntries = secrets.filter((entry) => entry.key === item.key);
              const healthy = providerEntries.filter((entry) => checks[entry.id]?.ok).length;
              const failed = providerEntries.filter((entry) => checks[entry.id] && !checks[entry.id].ok).length;
              return <button key={item.key} type="button" className={selected === item.key ? "btn btn-primary justify-start" : "btn justify-start"} onClick={() => choose(item.key)}><span className="flex min-w-0 items-center gap-2"><span className={failed ? "status-dot status-dot-error" : healthy ? "status-dot status-dot-ok" : providerEntries.length ? "status-dot status-dot-testing" : "status-dot status-dot-off"} /><span className="truncate">{item.label}</span></span><span className="mono ml-auto text-[10px] opacity-60">{providerEntries.length} key{providerEntries.length === 1 ? "" : "s"}</span></button>;
            })}
          </div>
          <p className="hint mt-3">You can add unlimited entries for the same provider. New credentials appear immediately without refreshing the page.</p>
        </div>

        <div className="flex flex-col gap-4">
          <form className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={async (event) => {
            event.preventDefault(); setBusy(true); setNotice(null);
            try {
              const data = await request("/api/v1/admin/secrets", { method: "POST", body: JSON.stringify({ key: selected, value }) }, csrf);
              setValue("");
              await refreshSecrets();
              setNotice(data.check?.ok ? "New credential saved and verified." : `New credential saved, but verification failed: ${data.check?.message ?? "Unknown error"}`);
            } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
            finally { setBusy(false); }
          }}>
            <div className="flex items-center justify-between gap-3"><div><label className="label" htmlFor="platform-secret-key">Add credential to</label><input id="platform-secret-key" className="input mono" value={selected} readOnly /></div><span className="status-badge neutral">{entries.length} stored</span></div>
            <div><label className="label" htmlFor="platform-secret-value">New API key / value</label><input id="platform-secret-value" className="input" type="password" value={value} onChange={(event) => setValue(event.target.value)} required placeholder="Paste a new credential" /></div>
            <p className="hint">{selectedMeta.hint}</p>
            <div className="flex flex-wrap items-center gap-2"><button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving & testing…" : "Add key + test"}</button>{notice ? <span className="text-[11px]" style={{ color: notice.includes("verified") ? "var(--color-success)" : "var(--color-danger)" }}>{notice}</span> : null}</div>
          </form>

          <div className="rounded-lg border overflow-hidden">
            <div className="border-b px-4 py-3"><div className="text-[12px] font-semibold">Stored {selectedMeta.label}s</div><div className="hint mt-0.5">Each entry has its own health status. Delete only the one you select.</div></div>
            {entries.length === 0 ? <div className="px-4 py-8 text-center text-[12px]" style={{ color: "var(--color-fg-muted)" }}>No credential stored for this provider yet.</div> : <div className="divide-y">{entries.map((entry) => { const check=checks[entry.id]; const testing=checking[entry.id]; return <div key={entry.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"><span className={testing ? "status-dot status-dot-testing" : check?.ok ? "status-dot status-dot-ok" : check ? "status-dot status-dot-error" : "status-dot status-dot-off"} title={testing ? "Testing…" : check?.message ?? "Not tested"} /><div className="min-w-0 flex-1"><div className="mono text-[11px]">••••{entry.last_four ?? ""}</div><div className="hint">Updated {new Date(entry.updated_at).toLocaleString()} {check?.status ? `· HTTP ${check.status}` : ""}</div>{check ? <div className="mt-1 text-[11px]" style={{ color: check.ok ? "var(--color-success)" : "var(--color-danger)" }}>{check.message}</div> : null}</div><div className="flex gap-2"><button className="btn" type="button" onClick={() => void verify(entry.id)} disabled={testing}>{testing ? "Testing…" : "Test"}</button><button className="btn" type="button" onClick={async () => { await request("/api/v1/admin/secrets", { method: "POST", body: JSON.stringify({ action: "delete", id: entry.id }) }, csrf); setSecrets((current) => current.filter((item) => item.id !== entry.id)); setChecks((current) => { const next={...current}; delete next[entry.id]; return next; }); }}>Delete</button></div></div>; })}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
