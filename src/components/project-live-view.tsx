"use client";

import { useEffect, useState } from "react";

type Deployment = { id: string; status: string; commitSha: string; url?: string | null; target: string; finishedAt?: string | null; updatedAt?: string | null };

export function ProjectLiveView({ projectId, csrf, initialUrl }: { projectId: string; csrf: string; initialUrl: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const response = await fetch(`/api/v1/projects/${projectId}/deployments?limit=10`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message ?? `Could not load deployments (${response.status})`);
    const rows = (data.data?.deployments ?? []) as Deployment[];
    setDeployments(rows);
    const ready = rows.find((item) => item.target === "PREVIEW" && ["HEALTHY", "PROMOTED", "BUILT"].includes(item.status) && item.url);
    if (ready?.url) setUrl(ready.url);
  };

  useEffect(() => { void refresh().catch((e) => setError(e instanceof Error ? e.message : String(e))); }, [projectId]);

  const build = async () => {
    setBusy(true); setError(null); setMessage("Creating a real preview deployment from the current production branch…");
    try {
      const current = deployments.find((item) => item.target === "PRODUCTION") ?? deployments[0];
      const body: Record<string, string> = { target: "PREVIEW" };
      if (current?.commitSha) body.commitSha = current.commitSha;
      const response = await fetch(`/api/v1/projects/${projectId}/deployments`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? `Preview deployment failed (${response.status})`);
      const deploymentId = data.data?.deployment?.id;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await refresh();
        const latest = deploymentId ? deployments.find((item) => item.id === deploymentId) : undefined;
        const rowsResponse = await fetch(`/api/v1/projects/${projectId}/deployments?limit=10`, { cache: "no-store" });
        const rowsData = await rowsResponse.json();
        const rows = (rowsData.data?.deployments ?? []) as Deployment[];
        const found = rows.find((item) => item.id === deploymentId) ?? latest;
        if (found?.url && ["HEALTHY", "PROMOTED", "BUILT"].includes(found.status)) { setUrl(found.url); setMessage(`Live View ready · ${found.status}`); break; }
        if (found && ["FAILED", "CANCELED"].includes(found.status)) throw new Error(`Preview deployment ${found.status}`);
        setMessage(`Building Live View… ${found?.status ?? "QUEUED"}`);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setMessage(""); }
    finally { setBusy(false); }
  };

  return <>
    <div className="flex flex-wrap items-center gap-2">
      <button className="btn btn-primary" type="button" onClick={() => void build()} disabled={busy}>{busy ? "Building Live View…" : "Build Live View"}</button>
      <button className="btn" type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button>
      <a className="btn" href={url} target="_blank" rel="noreferrer">Open in new tab ↗</a>
      {message ? <span className="hint">{message}</span> : null}
    </div>
    {error ? <div className="rounded-lg border p-3 text-[12px]" style={{ borderColor: "rgba(248,81,73,.3)", color: "#ff9b95" }}>{error}</div> : null}
    <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-white" style={{ borderColor: "var(--color-border)" }}>
      <iframe title="Project Live View" src={url} className="h-[calc(100vh-15rem)] min-h-[560px] w-full bg-white" loading="eager" />
    </div>
    <div className="grid gap-2 text-[10px]" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>{deployments.slice(0, 6).map((item) => <div key={item.id} className="rounded-lg border p-2"><div className="mono truncate">{item.commitSha?.slice(0, 10)}</div><div className="mt-1 flex justify-between"><span>{item.target}</span><span>{item.status}</span></div>{item.url ? <a className="mt-1 block truncate underline" href={item.url} target="_blank" rel="noreferrer">{item.url}</a> : null}</div>)}</div>
  </>;
}
