"use client";

import { useRef, useState } from "react";

export function GarvexFileReader({ csrf }: { csrf: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const readFile = async (file: File) => {
    setBusy(true); setError(null); setResult(null); setName(file.name);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("prompt", "Read this file carefully. For images describe the important visual details and extract visible text. For documents or code explain the important content and structure. For audio transcribe the spoken content.");
      const response = await fetch("/api/v1/admin/garvex/vision", { method: "POST", headers: { "x-csrf-token": csrf }, body: form });
      const text = await response.text();
      let data: { data?: { answer?: string } } = {};
      try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Invalid server response (${response.status})`); }
      if (!response.ok) throw new Error((data as { error?: { message?: string } }).error?.message ?? `Vision request failed (${response.status})`);
      setResult(data.data?.answer ?? "No analysis returned.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  return <>
    <button type="button" className="garvex-file-read-button" onClick={() => inputRef.current?.click()} disabled={busy} title="Read an image, video, audio or text file">{busy ? "◌ Reading…" : "⌕ Read file"}</button>
    <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/wav,audio/mpeg,audio/mp3,audio/webm,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.css,.html,.xml" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) { setOpen(true); void readFile(file); } event.currentTarget.value = ""; }} />
    {open ? <div className="garvex-file-reader-modal" role="dialog" aria-modal="true"><div className="garvex-file-reader-backdrop" onClick={() => setOpen(false)} /><section className="garvex-file-reader-card"><header><div><b>Garvex file reader</b><span>{name}</span></div><button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button></header>{busy ? <div className="garvex-file-reader-loading"><span /><span /><span /></div> : null}{error ? <div className="garvex-error">{error}</div> : null}{result ? <div className="garvex-file-reader-result" dir="auto">{result}</div> : null}</section></div> : null}
  </>;
}
