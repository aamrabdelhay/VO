"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

async function api(path: string, options: RequestInit & { csrf?: string } = {}) {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  if (options.csrf) headers.set("x-csrf-token", options.csrf);
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid server response (${response.status})`);
  }
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data && typeof (data as { error?: { message?: string } }).error?.message === "string"
      ? (data as { error: { message: string } }).error.message
      : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

function normalizeRepo(value: string) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://github.com/${trimmed}`);
    if (url.hostname.toLowerCase() !== "github.com") throw new Error("Use a github.com repository link.");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error("Use a repository link like https://github.com/owner/repo.");
    return `${parts[0]}/${parts[1].replace(/\.git$/, "")}`;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Invalid GitHub repository link.");
  }
}

export function GitHubProjectForm({ csrf }: { csrf: string }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "",
    githubUrl: "",
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

  const derivedRepo = useMemo(() => {
    try {
      return normalizeRepo(form.githubUrl);
    } catch {
      return "";
    }
  }, [form.githubUrl]);

  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const field = (key: keyof typeof form, label: string, placeholder = "", hint?: string) => (
    <div>
      <label className="label" htmlFor={`github-project-${key}`}>
        {label}
      </label>
      <input
        id={`github-project-${key}`}
        className="input"
        value={form[key]}
        placeholder={placeholder}
        onChange={(event) => update(key, event.target.value)}
      />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );

  return (
    <form
      className="grid gap-4 md:grid-cols-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const repoFullName = normalizeRepo(form.githubUrl);
          const inferredName = repoFullName.split("/")[1] ?? "project";
          const freeDomain = form.freeDomain.trim() || inferredName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
          const data = (await api("/api/v1/projects", {
            method: "POST",
            csrf,
            body: JSON.stringify({
              name: form.name.trim() || inferredName,
              repoFullName,
              freeDomain,
              productionBranch: form.productionBranch.trim() || "main",
              rootDirectory: form.rootDirectory.trim() || ".",
              installCommand: form.installCommand.trim(),
              buildCommand: form.buildCommand.trim(),
              startCommand: form.startCommand.trim(),
              healthPath: form.healthPath.trim() || "/",
            }),
          })) as { project: { id: string } };
          router.push(`/projects/${data.project.id}`);
          router.refresh();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setBusy(false);
        }
      }}
    >
      {field("githubUrl", "GitHub repository link", "https://github.com/owner/repo", "Paste the full GitHub URL. Garvex uses the repository as the source of truth for inspect, edit and deployment workflows.")}
      {field("name", "Project name", "Optional — defaults to the repository name")}
      {field("freeDomain", "Free domain", "storefront", "Optional. Creates a stable project URL when available.")}
      {field("productionBranch", "Production branch", "main")}
      {field("rootDirectory", "Root directory", ".")}
      {field("installCommand", "Install command", "auto-detected")}
      {field("buildCommand", "Build command", "auto-detected")}
      {field("startCommand", "Start command", "auto-detected")}
      {field("healthPath", "Health check path", "/")}
      <div className="md:col-span-2 flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" type="submit" disabled={busy || !derivedRepo}>
          {busy ? "Adding project…" : "Add GitHub project"}
        </button>
        {derivedRepo ? <span className="hint">Connected repository: {derivedRepo}</span> : null}
        {error ? <span role="alert" style={{ color: "var(--color-danger)", fontSize: 12 }}>{error}</span> : null}
      </div>
    </form>
  );
}
