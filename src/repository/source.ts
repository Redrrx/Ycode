import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { REPOSITORY_LIMITS } from "../config/constants.ts";
import {
  REPOSITORY_COMMANDS,
  inventoryArguments,
  observeOperation,
  outlineArguments,
  repositoryExecutable,
  type ObserveRepositoryOperation,
} from "./commands.ts";
import { parseOutline } from "./outline.ts";
import { referenceArguments, referenceLanguage } from "./reference-rules.ts";
import { parseReferences } from "./references.ts";
import { readTextSource } from "./text-read.ts";
import { inside, relativePath, treeFrom, type TreeNode } from "./tree.ts";
const exec = promisify(execFile);
const emptySearchSchema = z.object({
  code: z.literal(1),
  stdout: z.literal(""),
  stderr: z.literal(""),
});

export { isTextFileError } from "./text-read.ts";

export type Run = (
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  input?: string,
) => Promise<string>;

export const run: Run = async (command, args, cwd, signal, input) => {
  const executable = await repositoryExecutable(command);
  signal.throwIfAborted();
  const pending = exec(executable, args, {
    cwd,
    signal,
    timeout: REPOSITORY_LIMITS.commandTimeoutMs,
    maxBuffer: REPOSITORY_LIMITS.commandOutputBytes,
    encoding: "utf8",
  });

  pending.child.stdin?.on("error", () => undefined);
  pending.child.stdin?.end(input);
  return (await pending).stdout;
};

interface RepositoryData {
  inventoryComplete: boolean;
  readonly root: string;
  readonly signal: AbortSignal;
  readonly execute: Run;
  readonly workspaceRoot: string;
  readonly observe: ObserveRepositoryOperation | undefined;
}

export type Repository = Omit<ReturnType<typeof bindRepository>, "observe">;

export function createRepository(
  root: string,
  signal: AbortSignal,
  execute: Run = run,
  workspaceRoot = root,
  observe?: ObserveRepositoryOperation,
): Repository {
  const initialExecute: Run = (command, args, cwd, operationSignal, input) =>
    observeOperation(
      observe,
      { title: `${command} ${args.join(" ")}`, input: { command, args, cwd, stdin: input } },
      () => execute(command, args, cwd, operationSignal, input),
      (output) => output,
    );

  return bindRepository({
    inventoryComplete: false,
    root,
    signal,
    execute: initialExecute,
    workspaceRoot,
    observe,
  });
}

function bindRepository(self: RepositoryData) {
  return Object.assign(self, {
    displayPath: repositoryDisplayPath.bind(undefined, self),
    listDirectory: repositoryListDirectory.bind(undefined, self),
    literalPaths: repositoryLiteralPaths.bind(undefined, self),
    scan: repositoryScan.bind(undefined, self),
    exists: repositoryExists.bind(undefined, self),
    read: repositoryRead.bind(undefined, self),
    describe: repositoryDescribe,
    referenceSyntax: repositoryReferenceSyntax.bind(undefined, self),
    outline: repositoryOutline.bind(undefined, self),
  });
}

function repositoryDisplayPath(self: RepositoryData, path: string): string {
  return relativePath(self.workspaceRoot, resolve(self.root, path));
}

export async function openRepository(
  cwd: string,
  scope: string,
  signal: AbortSignal,
  execute: Run = run,
  observe?: ObserveRepositoryOperation,
) {
  const root = await realpath(cwd);
  const path = await realpath(resolve(root, scope.replace(/^@/, "")));

  if (!inside(root, path)) {
    throw new Error("Scope must remain inside the workspace");
  }

  return createRepository(path, signal, execute, root, observe);
}

async function repositoryScanPaths(self: RepositoryData): Promise<string> {
  try {
    return await self.execute(
      REPOSITORY_COMMANDS.inventory,
      inventoryArguments(),
      self.root,
      self.signal,
    );
  } catch (error) {
    if (emptySearchSchema.safeParse(error).success) {
      return "";
    }

    throw error;
  }
}

async function repositoryListDirectory(
  self: RepositoryData,
): Promise<{ name: string; directory: boolean; file: boolean }[]> {
  return observeOperation(
    self.observe,
    { title: `list_directory ${self.root}`, input: { path: self.root } },
    async () => {
      self.signal.throwIfAborted();
      const entries = await readdir(self.root, { withFileTypes: true });
      return entries
        .map((entry) => ({
          name: entry.name,
          directory: entry.isDirectory(),
          file: entry.isFile(),
        }))
        .sort(
          (left, right) =>
            Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name),
        );
    },
    (entries) => entries,
  );
}

async function repositoryLiteralPaths(self: RepositoryData, query: string): Promise<string[]> {
  try {
    const args = inventoryArguments().filter((arg) => arg !== "--files" && arg !== ".");
    const output = await self.execute(
      REPOSITORY_COMMANDS.inventory,
      ["--files-with-matches", "--fixed-strings", ...args, "--", query, "."],
      self.root,
      self.signal,
    );
    return output
      .split("\0")
      .filter(Boolean)
      .map((path) => path.replace(/^\.\//u, ""))
      .sort();
  } catch (error) {
    if (emptySearchSchema.safeParse(error).success) {
      return [];
    }
    throw error;
  }
}

async function repositoryScan(self: RepositoryData): Promise<TreeNode> {
  self.signal.throwIfAborted();
  const output = await repositoryScanPaths(self);
  const files = output
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replace(/^\.\//, ""))
    .sort();

  self.inventoryComplete = files.length <= REPOSITORY_LIMITS.sourceFiles;
  return treeFrom(files.slice(0, REPOSITORY_LIMITS.sourceFiles));
}

async function repositoryExists(self: RepositoryData, path: string): Promise<boolean> {
  self.signal.throwIfAborted();
  try {
    const canonical = await realpath(resolve(self.root, path));
    return inside(self.root, canonical) && (await stat(canonical)).isFile();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTDIR"].includes(String(error.code))
    ) {
      return false;
    }
    throw error;
  }
}

async function repositoryRead(
  self: RepositoryData,
  path: string,
  limit: number = REPOSITORY_LIMITS.sourceFileBytes,
): Promise<Buffer> {
  return observeOperation(
    self.observe,
    {
      title: `read_file ${repositoryDisplayPath(self, path)}`,
      input: { path: repositoryDisplayPath(self, path), scope: self.root, limitBytes: limit },
    },
    () => readTextSource(self.root, path, self.signal, limit),
    (source) => source.toString("utf8"),
  );
}

function repositoryDescribe(node: TreeNode): string {
  const children = [...node.children.values()];
  if (children.length === 0) {
    return `${node.path} (source file; contents not inspected yet)`;
  }
  const sample = children
    .slice(0, REPOSITORY_LIMITS.directoryPreviewChildren)
    .map(
      (child) =>
        `├── ${child.path}${child.children.size > 0 ? "/" : ""} (${child.files.length} source files)`,
    );
  const omitted = Math.max(0, children.length - sample.length);
  return [
    `${node.path}/ (${node.files.length} source files)`,
    ...sample,
    omitted > 0 ? `[${omitted} additional children not shown]` : "",
  ]
    .join("\n")
    .slice(0, REPOSITORY_LIMITS.directoryPreviewChars);
}

async function repositoryReferenceSyntax(self: RepositoryData, path: string, source: Buffer) {
  const language = referenceLanguage(path);
  if (!language) {
    return { status: "unsupported" as const, references: [] };
  }
  const output = await self.execute(
    REPOSITORY_COMMANDS.outline,
    referenceArguments(language),
    self.root,
    self.signal,
    source.toString("utf8"),
  );
  return parseReferences(output, source);
}

async function repositoryOutline(self: RepositoryData, path: string, source: Buffer) {
  const args = outlineArguments(resolve(self.root, path));
  const output = await self.execute(REPOSITORY_COMMANDS.outline, args, self.root, self.signal);

  if (!source.equals(await repositoryRead(self, path))) {
    throw new Error(`File changed during inspection: ${path}`);
  }

  return parseOutline(output, source.length);
}
