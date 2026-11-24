import { opendir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface WorkspaceFacts {
  git: boolean | null;
  contents: "empty" | "nonempty" | "unknown";
  sample: string[];
}

async function gitMarker(directory: string): Promise<boolean | null> {
  for (let depth = 0; depth < 32; depth++) {
    try {
      const marker = await stat(join(directory, ".git"));
      if (marker.isFile() || marker.isDirectory()) {
        return true;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        return null;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
  return null;
}

async function peek(directory: string): Promise<Omit<WorkspaceFacts, "git">> {
  const sample: string[] = [];
  try {
    const entries = await opendir(directory, { bufferSize: 8 });
    let inspected = 0;
    for await (const entry of entries) {
      if (entry.name !== ".git") {
        sample.push(entry.name.length > 48 ? `${entry.name.slice(0, 47)}…` : entry.name);
      }
      if (++inspected === 32 || sample.length === 6) {
        return { contents: sample.length ? "nonempty" : "unknown", sample };
      }
    }
    return { contents: sample.length ? "nonempty" : "empty", sample };
  } catch {
    return { contents: "unknown", sample };
  }
}

export async function inspectWorkspace(directory: string): Promise<WorkspaceFacts> {
  const [git, contents] = await Promise.all([gitMarker(directory), peek(directory)]);
  return { git, ...contents };
}
