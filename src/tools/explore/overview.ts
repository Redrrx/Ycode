import { createHash } from "node:crypto";
import { z } from "zod";
import type { RepositoryIndex } from "./state.ts";
const cursorSchema = z.object({ version: z.string(), offset: z.number().int().nonnegative() });
export interface OverviewOptions {
  depth?: number;
  cursor?: string;
}

function namePage(names: string[], offset: number): string[] {
  const entries: string[] = [];
  let used = 0;
  for (const path of names.slice(offset)) {
    if ((used + path.length > 2400 && entries.length > 0) || entries.length === 24) {
      break;
    }
    entries.push(path);
    used += path.length;
  }
  return entries;
}

export function workspaceStructure(state: RepositoryIndex, options: OverviewOptions = {}) {
  const directories = new Set(state.rootEntries.filter((path) => path.endsWith("/")));
  let maxDirectoryDepth = directories.size ? 1 : 0;
  for (const path of state.files) {
    const parts = path.split("/");
    maxDirectoryDepth = Math.max(maxDirectoryDepth, parts.length - 1);
    for (let index = 1; index < parts.length; index++) {
      directories.add(`${parts.slice(0, index).join("/")}/`);
    }
  }
  const depth = options.depth ?? 1;
  const names = [...new Set([...state.rootEntries, ...state.files, ...directories])]
    .filter((path) => path.replace(/\/$/u, "").split("/").length <= depth)
    .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b));
  const version = createHash("sha256")
    .update(JSON.stringify([state.id, depth, names]))
    .digest("hex");
  const cursor = options.cursor
    ? cursorSchema.parse(JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")))
    : { version, offset: 0 };
  if (cursor.version !== version) {
    throw new Error("Workspace listing changed or depth differs; restart without cursor");
  }
  const entries = namePage(names, cursor.offset);
  const offset = cursor.offset + entries.length;
  return {
    direct: state.directCounts,
    files: state.files.size,
    directories: directories.size,
    maxDirectoryDepth,
    counts: state.inventoryComplete ? "inventory_complete" : "inventory_partial",
    rootEntries: state.directoryEntries,
    depth,
    entries,
    nextCursor:
      offset < names.length
        ? Buffer.from(JSON.stringify({ version, offset })).toString("base64url")
        : null,
    note: "Counts cover inventoried files and their directories, plus visible root directories; ignored descendants and unvisited empty directories are not counted. Root depth is zero. Names do not establish behavior. No source was read.",
  };
}
