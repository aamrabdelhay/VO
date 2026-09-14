import assert from "node:assert/strict";
import { resolveWorkspacePath } from "@/lib/ai/workspace-path";

const workspace = "/tmp/proj-1";
assert.equal(resolveWorkspacePath(workspace, "src/app.ts"), "/tmp/proj-1/src/app.ts");
assert.throws(() => resolveWorkspacePath(workspace, "../sibling-dir"));
assert.throws(() => resolveWorkspacePath(workspace, "../proj-1-evil/file.txt"));
assert.throws(() => resolveWorkspacePath(workspace, "../../proj-1-evil"));
