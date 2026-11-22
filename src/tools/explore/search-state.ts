import { randomUUID } from "node:crypto";
import { isTextFileError } from "../../repository/source.ts";
import { treeFrom, type TreeNode } from "../../repository/tree.ts";
import type { SourceSearch } from "./source-search.ts";
export function unreadableSource(error: unknown): boolean {
  return (
    isTextFileError(error) ||
    (error instanceof Error &&
      "code" in error &&
      ["ENOENT", "EACCES", "ENOTDIR", "ELOOP", "EPERM"].includes(String(error.code)))
  );
}

export function searchCoverage(cursor: SearchCursor): Record<string, number> {
  const sources = [...cursor.sources.values()];
  return {
    rankedGroups: cursor.rankedGroups,
    expandedDirectories: cursor.expandedDirectories,
    searchedFiles: cursor.inspected.size,
    completedSourceFiles: sources.filter((source) => source.complete).length,
    remainingSourceRanges: sources.reduce(
      (total, source) => total + source.getRemainingRanges(),
      0,
    ),
    pendingEntries: cursor.pending.length,
    failedEntries: cursor.failed.size,
  };
}

export interface Entry {
  node: TreeNode;
  priority: number;
  offset: number;
  depth: number;
}

interface SearchCursorData {
  readonly id: ReturnType<typeof randomUUID>;
  readonly target: string;
  readonly pending: Entry[];
  readonly inspected: Set<string>;
  readonly failed: Set<string>;
  readonly sources: Map<string, SourceSearch>;
  steps: number;
  readonly visited: WeakMap<Entry, number>;
  rankedGroups: number;
  expandedDirectories: number;
  readonly literal: string | undefined;
}

export type SearchCursor = Omit<ReturnType<typeof bindSearchCursor>, "steps" | "visited">;

export function createSearchCursor(
  target: string,
  files: string[],
  readonlyLiteral?: string,
): SearchCursor {
  const id: ReturnType<typeof randomUUID> = randomUUID();

  const visited: WeakMap<Entry, number> = new WeakMap<Entry, number>();

  const pending: Entry[] = files.length
    ? [{ node: treeFrom(files), priority: 1, offset: 0, depth: 0 }]
    : [];

  return bindSearchCursor({
    id,
    target,
    pending,
    inspected: new Set<string>(),
    failed: new Set<string>(),
    sources: new Map<string, SourceSearch>(),
    steps: 0,
    visited,
    rankedGroups: 0,
    expandedDirectories: 0,
    literal: readonlyLiteral,
  });
}

function bindSearchCursor(self: SearchCursorData) {
  return Object.assign(self, { next: searchCursorNext.bind(undefined, self) });
}

function searchCursorNext(self: SearchCursorData): Entry | undefined {
  self.pending.sort(
    (left, right) =>
      right.priority - left.priority || left.node.path.localeCompare(right.node.path),
  );
  const continuation =
    self.steps % 3 === 2 ? self.pending.find((entry) => entry.offset > 0) : undefined;
  const fair = self.steps % 5 === 4 ? searchCursorOldestFresh(self) : undefined;
  const chosen =
    continuation ?? fair ?? self.pending.find((entry) => entry.offset === 0) ?? self.pending[0];
  if (!chosen) {
    return undefined;
  }
  self.pending.splice(self.pending.indexOf(chosen), 1);
  self.visited.set(chosen, ++self.steps);
  return chosen;
}

function searchCursorOldestFresh(self: SearchCursorData): Entry | undefined {
  return self.pending
    .filter((entry) => entry.offset === 0)
    .sort((a, b) => (self.visited.get(a) ?? 0) - (self.visited.get(b) ?? 0))[0];
}
