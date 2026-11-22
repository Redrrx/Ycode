import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { MUTATION_LIMITS } from "../../config/constants.ts";
import type { WriteJournal } from "../../project/writes.ts";
import { createRepository } from "../../repository/source.ts";
import { inside } from "../../repository/tree.ts";
export interface Mutation {
  operation: "edit" | "create";
  path: string;
  proposal: unknown;
  description?: string;
  operationId?: string;
}

export interface PreparedMutation {
  path: string;
  before: string;
  signal: AbortSignal;
  journal?: WriteJournal;
  description?: string;
  operationId?: string;
}

export async function prepareMutation(
  cwd: string,
  mutation: Mutation,
  signal: AbortSignal,
): Promise<PreparedMutation> {
  const root = await realpath(cwd);
  const requested = resolve(root, mutation.path);
  const parent = await realpath(dirname(requested));
  const path = resolve(parent, basename(requested));
  if (!inside(root, path)) {
    throw new Error("Mutation path must remain inside the workspace");
  }
  if (mutation.operation === "create") {
    return {
      path,
      before: "[New file; exclusive creation will reject any existing path]",
      signal,
      description: mutation.description,
      operationId: mutation.operationId,
    };
  }
  const canonical = await realpath(path);
  const repository = createRepository(root, signal);
  const before = await repository.read(canonical, MUTATION_LIMITS.inputBytes);
  return {
    path: canonical,
    before: before.toString("utf8"),
    signal,
    description: mutation.description,
    operationId: mutation.operationId,
  };
}

export function verifiedEdit(cwd: string, prepared: PreparedMutation) {
  const unchanged = async () => {
    prepared.signal.throwIfAborted();
    const current = await readFile(prepared.path, { signal: prepared.signal });
    if (current.toString("utf8") !== prepared.before) {
      throw new Error("File changed before the edit; no edit applied. Inspect again.");
    }
    return current;
  };
  return createEditToolDefinition(cwd, {
    operations: {
      access: (path) => access(path, constants.R_OK | constants.W_OK),
      readFile: unchanged,
      writeFile: async (path, content) => {
        await unchanged();
        prepared.signal.throwIfAborted();
        const write = prepared.journal?.begin(path, prepared.before, content, prepared);
        const handle = await open(path, "w");
        try {
          await handle.writeFile(content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        const saved = await readFile(path, "utf8");
        if (saved !== content) {
          throw new Error(
            "File was written but read-back verification failed; inspect before retrying.",
          );
        }
        if (write) {
          prepared.journal?.finish(write);
        }
      },
    },
  });
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createVerifiedFile(
  prepared: PreparedMutation,
  content: string,
): Promise<void> {
  prepared.signal.throwIfAborted();
  const write = prepared.journal?.begin(prepared.path, null, content, prepared);
  const handle = await open(prepared.path, "wx").catch((error: unknown) => {
    if (write) {
      prepared.journal?.cancel(write);
    }
    throw error;
  });
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(prepared.path));
  if ((await readFile(prepared.path, "utf8")) !== content) {
    throw new Error("File was created but read-back verification failed; inspect before retrying.");
  }
  if (write) {
    prepared.journal?.finish(write);
  }
}
