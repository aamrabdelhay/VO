"use client";

import { useState } from "react";

export function AIEditor({ csrf, projectId }: { csrf: string; projectId: string }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [baseSha, setBaseSha] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const call = async (body: unknown) => {
    const res = await fetch(`/api/v1/projects/${projectId}/ai/editor`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
    return data.data;
  };

  const prepare = async () => {
    if (!prompt.trim()) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const data = await call({ mode: "prepare", prompt });
      setReply(data.reply); setSummary(data.summary); setFiles(data.files ?? []); setBaseSha(data.baseSha ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const data = await call({ mode: "apply", baseSha, files, summary });
      setResult(data.pullRequest ? `Change published. PR: ${data.pullRequest}` : `Change published to ${data.branch}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-4 p-3.5">
      <div>
        <div className="label">Tell the AI what to change</div>
        <textarea
          className="input min-h-36 resize-y"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Example: Change the dashboard header to show the current project free domain and add a copy button."
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" onClick={() => void prepare()} disabled={busy || !prompt.trim()}>{busy ? "Working…" : "Prepare changes"}</button>
        {files.length > 0 ? <button className="btn" onClick={() => void apply()} disabled={busy}>Apply on GitHub</button> : null}
      </div>
      {reply ? <div><div className="label">AI</div><div className="whitespace-pre-wrap text-[12px]" style={{ color: "var(--color-fg-secondary)" }}>{reply}</div></div> : null}
      {summary ? <div><div className="label">Planned change</div><div className="text-[12px]">{summary}</div></div> : null}
      {baseSha ? <div className="hint mono">Base: {baseSha.slice(0, 12)}</div> : null}
      {files.length > 0 ? (
        <div className="border rounded-md overflow-hidden">
          <div className="border-b px-3 py-2 text-[11px]" style={{ color: "var(--color-fg-muted)" }}>{files.length} file(s) prepared</div>
          {files.map((file) => <div key={file.path} className="px-3 py-2 border-b last:border-b-0"><div className="mono text-[11px]">{file.path}</div><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[10.5px]" style={{ color: "var(--color-fg-muted)" }}>{file.content}</pre></div>)}
        </div>
      ) : null}
      {error ? <div style={{ color: "var(--color-danger)", fontSize: 11.5 }}>{error}</div> : null}
      {result ? <div style={{ color: "var(--color-success)", fontSize: 11.5 }}>{result}</div> : null}
    </div>
  );
}
