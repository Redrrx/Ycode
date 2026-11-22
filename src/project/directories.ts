import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import { redact, safeText } from "../activity/data.ts";
import { inside } from "../repository/tree.ts";
import type { ProjectDatabase } from "./database.ts";
import { tables } from "./tables.ts";
import { createVerificationStore } from "./verification.ts";
interface DirectoryStoreData {
  readonly database: ProjectDatabase;
}

export type DirectoryStore = Omit<ReturnType<typeof bindDirectoryStore>, "database">;

export function createDirectoryStore(database: ProjectDatabase): DirectoryStore {
  return bindDirectoryStore({ database });
}

function bindDirectoryStore(self: DirectoryStoreData) {
  return Object.assign(self, {
    begin: directoryStoreBegin.bind(undefined, self),
    finish: directoryStoreFinish.bind(undefined, self),
    reconcile: directoryStoreReconcile.bind(undefined, self),
  });
}

function directoryStoreBegin(
  self: DirectoryStoreData,
  task: string,
  revision: number,
  path: string,
  description: string,
): string {
  if (!inside(self.database.root, path)) {
    throw new Error("Directory journal path outside project");
  }
  createVerificationStore(self.database).invalidate();
  const id = randomUUID();
  const at = Date.now();
  self.database.orm
    .insert(tables.directories)
    .values({
      id,
      task,
      revision,
      path,
      status: "pending",
      created_at: at,
      updated_at: at,
      description: safeText(redact(description)).slice(0, 240),
    })
    .run();
  return id;
}

function directoryStoreFinish(
  self: DirectoryStoreData,
  id: string,
  status: "applied" | "not_applied",
): void {
  self.database.orm
    .update(tables.directories)
    .set({ status, updated_at: Date.now() })
    .where(eq(tables.directories.id, id))
    .run();
}

async function directoryStoreReconcile(self: DirectoryStoreData): Promise<string[]> {
  const conflicts: string[] = [];
  for (const value of self.database.orm
    .select()
    .from(tables.directories)
    .where(inArray(tables.directories.status, ["pending", "conflict"]))
    .all()) {
    const row = z.object({ id: z.string(), path: z.string() }).parse(value);
    const stat = await lstat(row.path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    let status = "retryable";
    if (stat) {
      status = "conflict";
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        status = inside(self.database.root, await realpath(row.path)) ? "applied" : "conflict";
      }
    }
    self.database.orm
      .update(tables.directories)
      .set({ status, updated_at: Date.now() })
      .where(eq(tables.directories.id, row.id))
      .run();
    if (status === "conflict") {
      conflicts.push(row.path);
    }
  }
  return conflicts;
}
