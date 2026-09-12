"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const PRESETS = [
  { key: "VERCEL_DEPLOY_TOKEN", label: "Vercel Deploy Token", hint: "Used by VO to create deployments and aliases on Vercel." },
  { key: "VERCEL_DEPLOY_TEAM_ID", label: "Vercel Team ID", hint: "Your Vercel team identifier; it is not a secret but is kept here with the hosting configuration." },
  { key: "NVIDIA_API_KEY", label: "NVIDIA API Key", hint: "Optional platform-wide NVIDIA AI key for the built-in AI editor." },
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
  const [selected, setSelected] = useState(PRESETS[0].key);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selectedMeta = PRESETS.find((item) => item.key === selected)!;
  const existing = initial.find((item) => item.key === selected);

  return (
    <div className="p-3.5">
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div>
          <label className="label" htmlFor="platform-secret-search">Quick add</label>
          <input
            id="platform-secret-search"
            className="input"
            placeholder="Search secret name…"
            list="platform-secret-presets"
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value.toUpperCase());
              setValue("");
              setMessage(null);
            }}
          />
          <datalist id="platform-secret-presets">
            {PRESETS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </datalist>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {PRESETS.map((item) => (
              <button key={item.key} type="button" className="btn" onClick={() => { setSelected(item.key); setValue(""); setMessage(null); }}>
                {item.label}
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
