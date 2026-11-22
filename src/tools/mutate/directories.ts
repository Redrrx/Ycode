import { defineTool } from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { TOOL_NAMES } from "../../config/constants.ts";
import type { DirectoryStore } from "../../project/directories.ts";
import { inside } from "../../repository/tree.ts";
import type { TaskSpec } from "../../workflow/protocol.ts";
import { syncDirectory } from "./files.ts";
async function stat(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}

async function createPath(
  root: string,
  path: string,
  taskSpec: TaskSpec,
  revision: number,
  store: DirectoryStore,
  changed: (path: string) => void,
  created: string[],
  signal?: AbortSignal,
) {
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    signal?.throwIfAborted();
    const parent = await realpath(current);
    if (!inside(root, parent)) {
      throw new Error("Directory parent escaped project");
    }
    current = resolve(parent, part);
    const existing = await stat(current);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error(`Directory component is a file or symlink: ${current}`);
      }
      continue;
    }
    const id = store.begin(
      taskSpec.id,
      revision,
      current,
      `Create directory: ${taskSpec.objective}`,
    );
    try {
      await mkdir(current);
      changed(current);
      created.push(relative(root, current));
      await syncDirectory(parent);
      if (!inside(root, await realpath(current))) {
        throw new Error("Created directory moved outside project; inspect before retrying");
      }
      store.finish(id, "applied");
    } catch (error) {
      if (!(await stat(current))) {
        store.finish(id, "not_applied");
      }
      throw error;
    }
  }
  return created;
}

interface DirectoryResult {
  path: string;
  created: string[];
  createdCount: number;
  status: "created" | "existing" | "failed";
  error?: string;
}
function directoryStatus(item: DirectoryResult): DirectoryResult["status"] {
  if (item.error) {
    return "failed";
  }
  return item.createdCount ? "created" : "existing";
}

function directoryResults(results: DirectoryResult[]) {
  const requested = results.length;
  const createdCount = results.reduce((sum, item) => sum + item.createdCount, 0);
  const failedRequests = results.filter((item) => item.error).length;
  while (Buffer.byteLength(JSON.stringify(results)) > 22000) {
    const largest = [...results].sort((a, b) => b.created.length - a.created.length)[0];
    if (largest && largest.created.length) {
      largest.created.pop();
    } else {
      results.pop();
    }
  }
  return {
    requested,
    createdCount,
    failedRequests,
    omittedRequests: requested - results.length,
    directories: results,
    note: "Created-path previews may be shortened; createdCount is exact. Full created changes remain in work_history.",
  };
}

export function directoryTool(
  taskSpec: TaskSpec,
  revision: number,
  store: DirectoryStore,
  changed: (path: string) => void,
) {
  return defineTool({
    name: TOOL_NAMES.directories,
    label: "Create Directories",
    executionMode: "sequential",
    description:
      "Create directories and missing parents inside cwd. Requires edit permission. Never replace files or follow symlinks. Existing directories stay unchanged. No decision calls. Keep successful changes if a later step fails. Nothing is deleted automatically.",
    parameters: Type.Object(
      { paths: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1 }) },
      { additionalProperties: false },
    ),
    async execute(_id, parameters, signal, _update, context) {
      if (taskSpec.mode !== "edit") {
        throw new Error("Directory creation requires edit permission");
      }
      if (Buffer.byteLength(JSON.stringify(parameters)) > 48000) {
        throw new Error("Directory request exceeds 48 KiB");
      }
      const root = await realpath(context.cwd);
      const paths = [
        ...new Set(parameters.paths.map((path) => resolve(root, path.replace(/^@/u, "")))),
      ];
      if (paths.some((path) => !inside(root, path))) {
        throw new Error("Directory paths must remain inside cwd");
      }
      const results: DirectoryResult[] = [];
      for (const path of paths) {
        signal?.throwIfAborted();
        const item: DirectoryResult = {
          path: relative(root, path),
          created: [],
          createdCount: 0,
          status: "existing",
        };
        results.push(item);
        try {
          await createPath(root, path, taskSpec, revision, store, changed, item.created, signal);
        } catch (error) {
          item.error = error instanceof Error ? error.message : String(error);
        }
        item.createdCount = item.created.length;
        item.status = directoryStatus(item);
      }
      const isError = results.some((item) => item.error);
      const data = directoryResults(results);
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data, isError };
    },
  });
}
