"use client";

import { useEffect, useState } from "react";

type Memory = { id: string; content: string; useCount: number; lastUsedAt: string | null };

export function GarvexMemoryPanel({ csrf }: { csrf: string }) {
  const [items, setItems] = useState<Memory[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch("/api/v1/admin/garvex/memory", { cache: "no-store" });
    if (!response.ok) { setError("Could not load memories"); return; }
    const data = (await response.json()) as { data?: Memory[] };
    setItems(data.data ?? []);
  }

  useEffect(() => { void load(); }, []);

  return <section aria-label="Garvex memory">
    <h2>Memory</h2>
    <p>Durable facts remembered by Garvex. You can inspect and remove every stored item.</p>
    {error ? <p role="alert">{error}</p> : null}
    {items.map((item) => <article key={item.id}>
      <p>{item.content}</p>
      <small>{item.useCount} uses{item.lastUsedAt ? ` · last used ${new Date(item.lastUsedAt).toLocaleString()}` : ""}</small>
      <button type="button" onClick={async () => { await fetch(`/api/v1/admin/garvex/memory?id=${encodeURIComponent(item.id)}`, { method: "DELETE", headers: { "x-csrf-token": csrf } }); await load(); }}>Delete</button>
    </article>)}
  </section>;
}
