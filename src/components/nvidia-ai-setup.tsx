"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const MODEL = "deepseek-ai/deepseek-v4-flash-0731";
const BASE_URL = "https://integrate.api.nvidia.com/v1";

export function NvidiaAISetup({ csrf, projectId, configured }: { csrf: string; projectId: string; configured: boolean }) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="p-3.5">
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div>
          <div className="label">Ready-made provider</div>
          <div className="mt-1 text-[13px] font-medium">NVIDIA NIM · DeepSeek V4 Flash</div>
          <div className="hint mt-1">{MODEL}</div>
          <div className="hint mt-1">{BASE_URL}</div>
          <p className="hint mt-3">This is a free NVIDIA endpoint currently listed for coding, chat and agentic workflows.</p>
        </div>
        <form className="flex flex-col gap-3" onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true); setMessage(null);
          try {
            const res = await fetch(`/api/v1/projects/${projectId}/ai`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-csrf-token": csrf },
              body: JSON.stringify({ action: "configure", provider: "nvidia", model: MODEL, baseUrl: BASE_URL, apiKey, dailyBudgetCents: 0 }),
            });
            const text = await res.text();
            const data = text ? JSON.parse(text) : {};
            if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
            setApiKey(""); setMessage("NVIDIA AI is configured in VO."); router.refresh();
          } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
          finally { setBusy(false); }
        }}>
          <label className="label" htmlFor="nvidia-key">NVIDIA API Key</label>
          <input id="nvidia-key" className="input" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={configured ? "Enter a new key to replace the current one" : "nvapi-…"} required />
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : configured ? "Update NVIDIA key" : "Enable NVIDIA AI"}</button>
          {message ? <span style={{ color: message.includes("configured") ? "var(--color-success)" : "var(--color-danger)", fontSize: 11.5 }}>{message}</span> : null}
        </form>
      </div>
    </div>
  );
}
