"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

async function api(path: string, init: RequestInit & { csrf?: string } = {}) {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.csrf ? { "x-csrf-token": init.csrf } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
  return json.data;
}

export function ActionButton({
  path,
  body,
  method = "POST",
  csrf,
  children,
  variant = "",
  confirm,
  onDone,
}: {
  path: string;
  body?: unknown;
  method?: string;
  csrf: string;
  children: ReactNode;
  variant?: "" | "btn-primary" | "btn-danger";
  confirm?: string;
  onDone?: (data: unknown) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        className={`btn ${variant}`}
        disabled={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setError(null);
          try {
            const data = await api(path, {
              method,
              csrf,
              body: body ? JSON.stringify(body) : undefined,
            });
            onDone?.(data);
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Working…" : children}
      </button>
      {error ? (
        <span style={{ color: "var(--color-danger)", fontSize: 11, maxWidth: 320 }}>{error}</span>
      ) : null}
    </span>
  );
}

export function LoginForm({ allowRegister }: { allowRegister: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("admin@platform.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api("/api/v1/auth", {
            method: "POST",
            body: JSON.stringify({ action: mode, email, password }),
          });
          router.push("/dashboard");
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="input"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      {error ? (
        <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12 }}>
          {error}
        </p>
      ) : null}
      <button className="btn btn-primary justify-center" type="submit" disabled={busy}>
        {busy ? "Signing in…" : mode === "login" ? "Sign in" : "Create account"}
      </button>
      {allowRegister ? (
        <button
          type="button"
          className="text-left"
          style={{ color: "var(--color-fg-muted)", fontSize: 11.5 }}
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "Create the first account" : "Back to sign in"}
        </button>
      ) : null}
    </form>
  );
}

export function NewProjectForm({ csrf }: { csrf: string }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "",
    repoFullName: "",
    freeDomain: "",
    productionBranch: "main",
    rootDirectory: ".",
    installCommand: "",
    buildCommand: "",
    startCommand: "",
    healthPath: "/",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const field = (key: keyof typeof form, label: string, placeholder = "", hint?: string) => (
    <div>
      <label className="label" htmlFor={key}>
        {label}
      </label>
      <input
        id={key}
        className="input"
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );

  return (
    <form
      className="grid gap-4 md:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const data = (await api("/api/v1/projects", {
            method: "POST",
            csrf,
            body: JSON.stringify(form),
          })) as { project: { id: string } };
          router.push(`/projects/${data.project.id}`);
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {field("name", "Project name", "storefront")}
      {field(
        "freeDomain",
        "Free domain",
        "storefront",
        "Creates a free stable URL like storefront.vercel.app. Must be unique on the platform.",
      )}
      {field("repoFullName", "GitHub repository", "owner/repo", "Source of truth for every deployment")}
      {field("productionBranch", "Production branch", "main")}
      {field("rootDirectory", "Root directory", ".")}
      {field("installCommand", "Install command", "auto-detected")}
      {field("buildCommand", "Build command", "auto-detected")}
      {field("startCommand", "Start command", "auto-detected")}
      {field("healthPath", "Health check path", "/")}
      <div className="md:col-span-2 flex items-center gap-3">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create project"}
        </button>
        {error ? <span style={{ color: "var(--color-danger)", fontSize: 12 }}>{error}</span> : null}
      </div>
    </form>
  );
}

export function SettingsForm({
  csrf,
  projectId,
  fields,
  values,
}: {
  csrf: string;
  projectId: string;
  fields: { key: string; label: string; type?: "text" | "number" | "boolean" | "select"; options?: string[]; hint?: string }[];
  values: Record<string, unknown>;
}) {
  const router = useRouter();
  const [form, setForm] = useState<Record<string, unknown>>(values);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="grid gap-4 p-3.5 md:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setStatus(null);
        try {
          await api(`/api/v1/projects/${projectId}`, {
            method: "PATCH",
            csrf,
            body: JSON.stringify(form),
          });
          setStatus("Saved");
          router.refresh();
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {fields.map((f) => (
        <div key={f.key}>
          <label className="label" htmlFor={f.key}>
            {f.label}
          </label>
          {f.type === "boolean" ? (
            <select
              id={f.key}
              className="select"
              value={String(form[f.key] ?? false)}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value === "true" })}
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          ) : f.type === "select" ? (
            <select
              id={f.key}
              className="select"
              value={String(form[f.key] ?? "")}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            >
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={f.key}
              className="input"
              type={f.type === "number" ? "number" : "text"}
              value={String(form[f.key] ?? "")}
              onChange={(e) =>
                setForm({
                  ...form,
                  [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value,
                })
              }
            />
          )}
          {f.hint ? <p className="hint">{f.hint}</p> : null}
        </div>
      ))}
      <div className="md:col-span-2 flex items-center gap-3">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {status ? <span style={{ fontSize: 11.5, color: "var(--color-fg-muted)" }}>{status}</span> : null}
      </div>
    </form>
  );
}

export function EnvVarForm({ csrf, projectId }: { csrf: string; projectId: string }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState("PRODUCTION");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-wrap items-end gap-3 p-3.5"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api(`/api/v1/projects/${projectId}/env`, {
            method: "POST",
            csrf,
            body: JSON.stringify({ key, value, scope }),
          });
          setKey("");
          setValue("");
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }}
    >
      <div className="min-w-[180px] flex-1">
        <label className="label" htmlFor="env-key">
          Key
        </label>
        <input id="env-key" className="input" value={key} onChange={(e) => setKey(e.target.value)} required />
      </div>
      <div className="min-w-[220px] flex-1">
        <label className="label" htmlFor="env-value">
          Value
        </label>
        <input
          id="env-value"
          className="input"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="env-scope">
          Scope
        </label>
        <select id="env-scope" className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option>PRODUCTION</option>
          <option>PREVIEW</option>
          <option>DEVELOPMENT</option>
        </select>
      </div>
      <button className="btn btn-primary" type="submit">
        Add variable
      </button>
      {error ? <span style={{ color: "var(--color-danger)", fontSize: 11.5 }}>{error}</span> : null}
    </form>
  );
}

export function DomainForm({ csrf, projectId }: { csrf: string; projectId: string }) {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-3 p-3.5"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api(`/api/v1/projects/${projectId}/domains`, {
            method: "POST",
            csrf,
            body: JSON.stringify({ domain }),
          });
          setDomain("");
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }}
    >
      <div className="min-w-[260px] flex-1">
        <label className="label" htmlFor="domain">
          Custom domain
        </label>
        <input
          id="domain"
          className="input"
          placeholder="app.example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          required
        />
      </div>
      <button className="btn btn-primary" type="submit">
        Add domain
      </button>
      {error ? <span style={{ color: "var(--color-danger)", fontSize: 11.5 }}>{error}</span> : null}
    </form>
  );
}

export function LogStream({ deploymentId, live }: { deploymentId: string; live: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const [autoscroll, setAutoscroll] = useState(true);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const data = (await api(`/api/v1/deployments/${deploymentId}/logs`)) as {
        chunks: { content: string }[];
      };
      if (!cancelled) setLines(data.chunks.map((c) => c.content));
    };
    void load();
    if (!live) return;
    const source = new EventSource(`/api/v1/deployments/${deploymentId}/logs?stream=1`);
    source.onmessage = (event) => {
      setLines((prev) => [...prev.slice(-2000), JSON.parse(event.data) as string]);
    };
    return () => {
      cancelled = true;
      source.close();
    };
  }, [deploymentId, live]);

  useEffect(() => {
    if (autoscroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, autoscroll]);

  const visible = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b px-3.5 py-2">
        <input
          className="input max-w-[240px]"
          placeholder="Search logs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Search logs"
        />
        <label className="flex items-center gap-1.5" style={{ fontSize: 11.5, color: "var(--color-fg-secondary)" }}>
          <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
          Auto-scroll
        </label>
        <button
          type="button"
          className="btn"
          onClick={() => navigator.clipboard?.writeText(visible.join("\n"))}
        >
          Copy
        </button>
        <a className="btn" href={`/api/v1/deployments/${deploymentId}/logs?durable=1`}>
          Download
        </a>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-fg-muted)" }}>
          {visible.length} lines {live ? "· streaming" : ""}
        </span>
      </div>
      <div className="log-view" ref={ref}>
        {visible.length === 0
          ? "No log output retained for this deployment."
          : visible.map((line, i) => (
              <div key={i} className={/error|failed|fatal/i.test(line) ? "log-line-error" : undefined}>
                {line}
              </div>
            ))}
      </div>
    </div>
  );
}

export function AIConfigForm({ csrf, projectId, provider, model }: { csrf: string; projectId: string; provider: string | null; model: string | null }) {
  const router = useRouter();
  const [form, setForm] = useState({
    provider: provider ?? "anthropic",
    model: model ?? "claude-sonnet-4-5",
    apiKey: "",
    baseUrl: "",
    dailyBudgetCents: 500,
  });
  const [status, setStatus] = useState<string | null>(null);

  return (
    <form
      className="grid gap-3 p-3.5 md:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api(`/api/v1/projects/${projectId}/ai`, {
            method: "POST",
            csrf,
            body: JSON.stringify({ action: "configure", ...form }),
          });
          setStatus("Provider saved");
          setForm({ ...form, apiKey: "" });
          router.refresh();
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err));
        }
      }}
    >
      <div>
        <label className="label" htmlFor="provider">
          Provider
        </label>
        <select
          id="provider"
          className="select"
          value={form.provider}
          onChange={(e) => setForm({ ...form, provider: e.target.value })}
        >
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
          <option value="gemini">gemini</option>
          <option value="openai-compatible">openai-compatible</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="model">
          Model
        </label>
        <input id="model" className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="apiKey">
          API key (BYOK)
        </label>
        <input
          id="apiKey"
          className="input"
          type="password"
          placeholder="stored encrypted"
          value={form.apiKey}
          onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
        />
      </div>
      <div>
        <label className="label" htmlFor="baseUrl">
          Base URL (optional)
        </label>
        <input id="baseUrl" className="input" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
      </div>
      <div className="md:col-span-2 flex items-center gap-3">
        <button className="btn btn-primary" type="submit">
          Save provider
        </button>
        {status ? <span style={{ fontSize: 11.5, color: "var(--color-fg-muted)" }}>{status}</span> : null}
      </div>
    </form>
  );
}