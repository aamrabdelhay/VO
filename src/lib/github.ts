import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const API = "https://api.github.com";
const CODELOAD = "https://codeload.github.com";

export type CommitInfo = {
  sha: string;
  message: string;
  author: string;
  date: string;
};

function headers(token?: string | null) {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "self-hosted-deploy-platform",
    "x-github-api-version": "2022-11-28",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

export function assertRepoFullName(fullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new Error("Invalid repository name, expected owner/repo");
  }
  return fullName;
}

async function ghFetch(url: string, token?: string | null, init?: RequestInit) {
  // Only fixed GitHub hosts are reachable from this client (SSRF containment).
  if (!url.startsWith(API) && !url.startsWith(CODELOAD)) throw new Error("Blocked host");
  const res = await fetch(url, { ...init, headers: { ...headers(token), ...(init?.headers ?? {}) } });
  return res;
}

export async function getRepo(fullName: string, token?: string | null) {
  assertRepoFullName(fullName);
  const res = await ghFetch(`${API}/repos/${fullName}`, token);
  if (!res.ok) throw new Error(`GitHub repo lookup failed (${res.status})`);
  const data = (await res.json()) as {
    full_name: string;
    default_branch: string;
    private: boolean;
    html_url: string;
  };
  return data;
}

export async function getBranchCommit(
  fullName: string,
  branch: string,
  token?: string | null,
): Promise<CommitInfo> {
  assertRepoFullName(fullName);
  const res = await ghFetch(
    `${API}/repos/${fullName}/commits/${encodeURIComponent(branch)}`,
    token,
  );
  if (!res.ok) throw new Error(`GitHub commit lookup failed (${res.status})`);
  const data = (await res.json()) as {
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
  };
  return {
    sha: data.sha,
    message: data.commit.message,
    author: data.commit.author?.name ?? "unknown",
    date: data.commit.author?.date ?? new Date().toISOString(),
  };
}

export async function listBranches(fullName: string, token?: string | null) {
  const res = await ghFetch(`${API}/repos/${fullName}/branches?per_page=100`, token);
  if (!res.ok) throw new Error(`GitHub branch listing failed (${res.status})`);
  return (await res.json()) as { name: string; commit: { sha: string } }[];
}

/**
 * Materialises the *exact* commit into an isolated workspace directory.
 * Uses the codeload tarball (no history, no credentials in the workspace).
 */
export async function fetchCommitTarball(
  fullName: string,
  sha: string,
  destination: string,
  token?: string | null,
) {
  assertRepoFullName(fullName);
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("Invalid commit sha");
  await fs.mkdir(destination, { recursive: true });
  const tarPath = path.join(destination, "source.tar.gz");
  const res = await ghFetch(`${CODELOAD}/${fullName}/tar.gz/${sha}`, token);
  if (!res.ok || !res.body) throw new Error(`Source download failed (${res.status})`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tarPath));

  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", tarPath, "-C", destination, "--strip-components=1"], {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar extraction failed with code ${code}`)),
    );
  });
  await fs.rm(tarPath, { force: true });
  return destination;
}

export async function postCommitStatus(
  fullName: string,
  sha: string,
  token: string,
  body: { state: "pending" | "success" | "failure" | "error"; target_url?: string; description?: string; context?: string },
) {
  const res = await ghFetch(`${API}/repos/${fullName}/statuses/${sha}`, token, {
    method: "POST",
    body: JSON.stringify({ context: "deploy-platform", ...body }),
  });
  return res.ok;
}

/** Creates or updates a single PR comment (never spams the thread). */
export async function upsertPrComment(
  fullName: string,
  prNumber: number,
  token: string,
  marker: string,
  body: string,
) {
  const list = await ghFetch(
    `${API}/repos/${fullName}/issues/${prNumber}/comments?per_page=100`,
    token,
  );
  if (list.ok) {
    const comments = (await list.json()) as { id: number; body: string }[];
    const existing = comments.find((c) => c.body?.includes(marker));
    if (existing) {
      const res = await ghFetch(`${API}/repos/${fullName}/issues/comments/${existing.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ body: `${marker}\n${body}` }),
      });
      return res.ok;
    }
  }
  const res = await ghFetch(`${API}/repos/${fullName}/issues/${prNumber}/comments`, token, {
    method: "POST",
    body: JSON.stringify({ body: `${marker}\n${body}` }),
  });
  return res.ok;
}

export async function createBranchRef(
  fullName: string,
  token: string,
  branch: string,
  fromSha: string,
) {
  const res = await ghFetch(`${API}/repos/${fullName}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  });
  return res.ok;
}

export async function createPullRequest(
  fullName: string,
  token: string,
  input: { title: string; head: string; base: string; body: string },
) {
  const res = await ghFetch(`${API}/repos/${fullName}/pulls`, token, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  return (await res.json()) as { number: number; html_url: string };
}

/**
 * Creates a commit on a branch through the Git Data API (blobs -> tree -> commit -> ref).
 * The platform never pushes from a workspace with credentials on disk.
 */
export async function commitFiles(
  fullName: string,
  token: string,
  input: { branch: string; baseSha: string; message: string; files: { path: string; content: string }[] },
) {
  assertRepoFullName(fullName);
  const base = `${API}/repos/${fullName}`;
  const blobs: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const file of input.files) {
    const res = await ghFetch(`${base}/git/blobs`, token, {
      method: "POST",
      body: JSON.stringify({ content: Buffer.from(file.content).toString("base64"), encoding: "base64" }),
    });
    if (!res.ok) throw new Error(`Blob creation failed for ${file.path} (${res.status})`);
    const blob = (await res.json()) as { sha: string };
    blobs.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const treeRes = await ghFetch(`${base}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify({ base_tree: input.baseSha, tree: blobs }),
  });
  if (!treeRes.ok) throw new Error(`Tree creation failed (${treeRes.status})`);
  const tree = (await treeRes.json()) as { sha: string };

  const commitRes = await ghFetch(`${base}/git/commits`, token, {
    method: "POST",
    body: JSON.stringify({ message: input.message, tree: tree.sha, parents: [input.baseSha] }),
  });
  if (!commitRes.ok) throw new Error(`Commit creation failed (${commitRes.status})`);
  const commit = (await commitRes.json()) as { sha: string };

  const refRes = await ghFetch(`${base}/git/refs/heads/${input.branch}`, token, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  if (!refRes.ok) {
    const created = await ghFetch(`${base}/git/refs`, token, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: commit.sha }),
    });
    if (!created.ok) throw new Error(`Branch update failed (${created.status})`);
  }
  return commit.sha;
}
