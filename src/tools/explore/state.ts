import { createHash, randomUUID } from "node:crypto";
import { EXPLORATION_LIMITS as LIMITS } from "../../config/constants.ts";
import type { SymbolInfo } from "../../repository/outline.ts";
import type { ReferenceSyntax } from "../../repository/references.ts";
import type { Repository } from "../../repository/source.ts";
import { inside } from "../../repository/tree.ts";
import type { Finding } from "./result.ts";
import type { SearchCursor } from "./search-state.ts";
import type { WorkspaceIndex } from "./workspace-index.ts";
import { createWorkspaceIndex } from "./workspace-index.ts";
export const MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
]);

interface RepositoryIndexData {
  readonly id: string;
  invalidated: boolean;
  inventoried: boolean;
  inventoryComplete: boolean;
  summary: string;
  summaryPaths: string[];
  summaryStale: boolean;
  readonly searches: Map<string, SearchCursor>;
  readonly outlines: Map<string, { digest: string; symbols: SymbolInfo[] }>;
  readonly referenceSyntax: Map<string, { digest: string; syntax: ReferenceSyntax }>;
  readonly root: string;
  readonly workspace: string;
  readonly files: Set<string>;
  readonly rootEntries: string[];
  readonly directoryEntries: number;
  readonly directCounts: { files: number; directories: number; other: number };
  readonly examined: Map<string, string>;
  readonly known: Set<string>;
  readonly notices: string[];
  outlined: number;
  referenceAnalyses: number;
  reads: number;
  attempts: number;
}

export type RepositoryIndex = ReturnType<typeof bindRepositoryIndex>;

export function createRepositoryIndex(
  repository: Repository,
  files: string[],
  entries: { name: string; directory: boolean; file?: boolean }[] = [],
  id?: string,
): RepositoryIndex {
  const initialId: string = id ?? randomUUID();
  const initialRoot: string = repository.root;
  const workspace: string = repository.workspaceRoot;

  const rootEntries: string[] = entries.map(
    (entry) => `${entry.name}${entry.directory ? "/" : ""}`,
  );
  const directoryEntries: number = entries.length;
  const directories = entries.filter((entry) => entry.directory).length;
  const directFiles = entries.filter((entry) => entry.file).length;
  const directCounts: { files: number; directories: number; other: number } = {
    files: directFiles,
    directories,
    other: entries.length - directories - directFiles,
  };
  return bindRepositoryIndex({
    id: initialId,
    invalidated: false,
    inventoried: false,
    inventoryComplete: false,
    summary: "",
    summaryPaths: [],
    summaryStale: false,
    searches: new Map<string, SearchCursor>(),
    outlines: new Map<string, { digest: string; symbols: SymbolInfo[] }>(),
    referenceSyntax: new Map<string, { digest: string; syntax: ReferenceSyntax }>(),
    root: initialRoot,
    workspace,
    files: new Set(files),
    rootEntries,
    directoryEntries,
    directCounts,
    examined: new Map<string, string>(),
    known: new Set(files),
    notices: [],
    outlined: 0,
    referenceAnalyses: 0,
    reads: 0,
    attempts: 0,
  });
}

function bindRepositoryIndex(self: RepositoryIndexData) {
  return Object.assign(self, { visibleTree: repositoryIndexVisibleTree.bind(undefined, self) });
}

export async function loadRepositoryIndex(
  repository: Repository,
  id?: string,
  inventory = true,
): Promise<RepositoryIndex> {
  const entries = inventory ? await repository.listDirectory() : [];
  const files = inventory ? (await repository.scan()).files : [];
  const manifests = entries
    .filter((entry) => !entry.directory && MANIFESTS.has(entry.name))
    .map((entry) => entry.name);
  const state = createRepositoryIndex(
    repository,
    [...new Set([...files, ...manifests])],
    entries,
    id,
  );
  state.inventoried = inventory;
  state.inventoryComplete = inventory && repository.inventoryComplete;
  if (inventory && !state.inventoryComplete) {
    state.notices.push("Inventory is partial; narrow the scope for complete counts and search");
  }
  if (inventory && manifests.length === 0) {
    state.notices.push(
      "No supported root manifest in this scope. Parent dependency metadata remains unknown; available source can still explain the project.",
    );
  }
  return state;
}

function repositoryIndexVisibleTree(self: RepositoryIndexData): string {
  const paths = new Set<string>();
  for (const path of self.known) {
    const parts = path.split("/");
    parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join("/")));
  }
  const rendered = [
    `Root entries (names only; showing ${self.rootEntries.length} of ${self.directoryEntries}): ${self.rootEntries.join(", ")}`,
    "Inventoried paths (ignore rules and exclusions apply; not a complete filesystem listing):",
    "./",
    ...[...paths].sort().map((path) => {
      const parts = path.split("/");
      const suffix = self.known.has(path) ? "" : "/";
      return `${"│   ".repeat(parts.length - 1)}├── ${parts.at(-1)}${suffix}`;
    }),
  ].join("\n");
  if (rendered.length > LIMITS.treeChars) {
    return `${rendered.slice(0, LIMITS.treeChars)}\n[Tree preview shortened]`;
  }
  return rendered;
}

interface SearchStateData {
  readonly investigations: Map<string, RepositoryIndex>;
  readonly sourceHashes: Map<string, string>;
  readonly excerpts: Set<string>;
  notes: string;
  decisionUnavailable: boolean;
  generation: number;
  readonly workspaces: WorkspaceIndex;
}

export type SearchState = Omit<ReturnType<typeof bindSearchState>, "excerpts">;

export function createSearchState(workspaces = createWorkspaceIndex()): SearchState {
  return bindSearchState({
    investigations: new Map<string, RepositoryIndex>(),
    sourceHashes: new Map<string, string>(),
    excerpts: new Set<string>(),
    notes: "",
    decisionUnavailable: false,
    generation: 0,
    workspaces,
  });
}

function bindSearchState(self: SearchStateData) {
  return Object.assign(self, {
    recordFindings: searchStateRememberFindings.bind(undefined, self),
    saveWorkspace: searchStateSaveWorkspace.bind(undefined, self),
    invalidate: searchStateInvalidate.bind(undefined, self),
    changed: searchStateChanged.bind(undefined, self),
    resolve: searchStateResolve.bind(undefined, self),
  });
}

function searchStateRememberFindings(
  self: SearchStateData,
  workspace: string,
  findings: Finding[],
): string[] {
  const repeated: string[] = [];
  for (const finding of findings) {
    const key = createHash("sha256")
      .update(JSON.stringify([workspace, finding]))
      .digest("hex");
    if (self.excerpts.has(key)) {
      repeated.push(finding.path);
    } else {
      self.excerpts.add(key);
    }
  }
  return repeated.length
    ? [
        `Unchanged excerpts already returned: ${repeated.join(", ")}. The source is still in this request. Reuse it. Read more only for missing details or to verify a change.`,
      ]
    : [];
}

function searchStateSaveWorkspace(self: SearchStateData, state: RepositoryIndex): void {
  self.workspaces.put({
    id: state.id,
    workspace: state.workspace,
    root: state.root,
    summary: state.summary,
    sourcePaths: state.summaryPaths,
    stale: state.summaryStale,
  });
}

function searchStateInvalidate(self: SearchStateData, changed = false): void {
  if (changed) {
    self.generation++;
  }
  self.sourceHashes.clear();
  for (const state of self.investigations.values()) {
    state.invalidated = true;
    state.summaryStale = true;
  }
  for (const record of self.workspaces.list()) {
    self.workspaces.changed(record.root);
  }
}

function searchStateChanged(self: SearchStateData, path: string): void {
  self.generation++;
  self.sourceHashes.delete(path);
  for (const investigation of self.investigations.values()) {
    if (inside(investigation.root, path)) {
      investigation.invalidated = true;
      investigation.summaryStale = true;
    }
  }
  self.workspaces.changed(path);
}

async function searchStateCurrent(
  self: SearchStateData,
  repository: Repository,
  state: RepositoryIndex,
  inventory: boolean,
): Promise<RepositoryIndex> {
  if (!state.invalidated && (state.inventoried || !inventory)) {
    return state;
  }
  const fresh = await loadRepositoryIndex(repository, state.id, inventory);
  if (!state.invalidated) {
    for (const [path, description] of state.examined) {
      fresh.examined.set(path, description);
      fresh.known.add(path);
    }
  }
  fresh.summary = state.summary;
  fresh.summaryPaths = [...state.summaryPaths];
  fresh.summaryStale = state.invalidated || state.summaryStale;
  self.investigations.set(state.id, fresh);
  return fresh;
}

async function searchStateResolve(
  self: SearchStateData,
  repository: Repository,
  id?: string,
  inventory = true,
): Promise<RepositoryIndex> {
  if (id) {
    const state = self.investigations.get(id) ?? self.workspaces.get(id);
    if (
      !state ||
      state.workspace !== repository.workspaceRoot ||
      !inside(state.root, repository.root)
    ) {
      throw new Error("Unknown investigation or scope outside its boundary");
    }
    if (state.root !== repository.root) {
      return searchStateResolve(self, repository, undefined, inventory);
    }
    const active = self.investigations.get(id);
    if (active) {
      return searchStateCurrent(self, repository, active, inventory);
    }
  }
  const previous = [...self.investigations.values()].find(
    (state) => state.root === repository.root && state.workspace === repository.workspaceRoot,
  );
  if (previous) {
    return searchStateCurrent(self, repository, previous, inventory);
  }
  const saved = self.workspaces
    .list()
    .find(
      (record) => record.workspace === repository.workspaceRoot && record.root === repository.root,
    );
  const state = await loadRepositoryIndex(repository, saved?.id, inventory);
  if (saved) {
    state.summary = saved.summary;
    state.summaryPaths = [...saved.sourcePaths];
    state.summaryStale = saved.stale;
  }
  self.investigations.set(state.id, state);
  searchStateSaveWorkspace(self, state);
  return state;
}
