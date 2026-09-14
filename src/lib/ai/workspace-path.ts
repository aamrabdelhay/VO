import path from "node:path";

export function resolveWorkspacePath(workspace: string, requestedPath: string) {
  const root = path.resolve(workspace);
  const full = path.resolve(root, requestedPath);
  const relative = path.relative(root, full);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) return full;
  throw new Error("Path escapes the AI workspace");
}
