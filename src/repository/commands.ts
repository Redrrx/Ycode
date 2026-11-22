import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export async function repositoryExecutable(command: string): Promise<string> {
  if (command === REPOSITORY_COMMANDS.inventory) {
    return (await import("@vscode/ripgrep")).rgPath;
  }
  if (command === REPOSITORY_COMMANDS.outline) {
    const directory = dirname(createRequire(import.meta.url).resolve("@ast-grep/cli/package.json"));
    return join(directory, process.platform === "win32" ? "ast-grep.exe" : "ast-grep");
  }
  throw new Error(`Unknown repository command: ${command}`);
}

export const REPOSITORY_COMMANDS = {
  inventory: "rg",
  outline: "ast-grep",
} as const;

const outlineExtensions = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "rb",
  "php",
  "swift",
  "kt",
  "vue",
  "svelte",
]);

export function supportsOutline(path: string): boolean {
  return outlineExtensions.has(path.split(".").at(-1)?.toLowerCase() ?? "");
}
const excludedDirectories = ["node_modules", "vendor", "dist", "build"];

export function inventoryArguments(): string[] {
  return [
    "--files",
    "--null",
    "--path-separator",
    "/",
    ...excludedDirectories.flatMap((directory) => ["--glob", `!**/${directory}/**`]),
    ".",
  ];
}

export function outlineArguments(absolutePath: string): string[] {
  return [
    "outline",
    "--items",
    "structure",
    "--json=compact",
    "--custom-languages",
    "ignore",
    absolutePath,
  ];
}

export interface RepositoryOperation {
  title: string;
  input: unknown;
}

export interface RepositoryOperationSpan {
  complete(output: unknown): void;
  fail(error: unknown): void;
}

export type ObserveRepositoryOperation = (
  operation: RepositoryOperation,
) => RepositoryOperationSpan;

export async function observeOperation<T>(
  observe: ObserveRepositoryOperation | undefined,
  operation: RepositoryOperation,
  execute: () => Promise<T>,
  describe: (result: T) => unknown,
): Promise<T> {
  const span = observe?.(operation);
  try {
    const result = await execute();
    span?.complete(describe(result));
    return result;
  } catch (error) {
    span?.fail(error);
    throw error;
  }
}
