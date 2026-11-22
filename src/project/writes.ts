import { and, eq, inArray } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { redact, safeText } from "../activity/data.ts";
import { TOOL_NAMES } from "../config/constants.ts";
import { inside } from "../repository/tree.ts";
import { workspaceRecordSchema } from "../tools/explore/workspace-index.ts";
import { encode, type ProjectDatabase } from "./database.ts";
import { createDirectoryStore } from "./directories.ts";
import { tables } from "./tables.ts";
import { createVerificationStore } from "./verification.ts";
export interface WriteJournal {
  begin(
    path: string,
    before: string | null,
    after: string,
    metadata?: { description?: string; operationId?: string },
  ): string;
  finish(id: string): void;
  cancel(id: string): void;
}

function hash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

interface WriteStoreData {
  readonly database: ProjectDatabase;
}

export type WriteStore = Omit<ReturnType<typeof bindWriteStore>, "database">;

export function createWriteStore(database: ProjectDatabase): WriteStore {
  return bindWriteStore({ database });
}

function bindWriteStore(self: WriteStoreData) {
  return Object.assign(self, {
    createJournal: writeStoreForTask.bind(undefined, self),
    reconcile: writeStoreReconcile.bind(undefined, self),
  });
}

function writeStoreForTask(self: WriteStoreData, task: string, revision: number): WriteJournal {
  return {
    begin: (path, before, after, metadata) => {
      if (!inside(self.database.root, path)) {
        throw new Error("Write journal path outside project");
      }
      const id = randomUUID();
      const at = Date.now();
      const operation = writeStoreOperation(self, task, revision, metadata?.operationId);
      const spec = self.database.orm
        .select({ spec: tables.tasks.spec })
        .from(tables.tasks)
        .where(eq(tables.tasks.id, task))
        .get();
      const objective = spec
        ? z.object({ objective: z.string() }).parse(JSON.parse(spec.spec)).objective
        : undefined;
      const description = safeText(
        redact(
          metadata?.description ??
            operation?.description ??
            objective ??
            `${before === null ? "Create" : "Edit"} file`,
        ),
      )
        .replaceAll("\n", " ")
        .slice(0, 240);
      self.database.transaction(() => {
        createVerificationStore(self.database).invalidate();
        self.database.orm
          .insert(tables.writes)
          .values({
            id,
            task,
            revision,
            path,
            before_hash: before === null ? null : hash(before),
            after_hash: hash(after),
            status: "pending",
            created_at: at,
            updated_at: at,
            description,
            operation_id: operation?.id ?? null,
          })
          .run();
        for (const row of self.database.orm.select().from(tables.workspaces).all()) {
          const saved = z.object({ data: z.string() }).parse(row);
          const workspace = workspaceRecordSchema.parse(JSON.parse(saved.data));
          if (inside(workspace.root, path) && !workspace.stale) {
            self.database.orm
              .update(tables.workspaces)
              .set({ data: encode({ ...workspace, stale: true }) })
              .where(eq(tables.workspaces.id, workspace.id))
              .run();
          }
        }
      });
      return id;
    },
    cancel: (id) => {
      self.database.orm
        .update(tables.writes)
        .set({ status: "not_applied", updated_at: Date.now() })
        .where(and(eq(tables.writes.id, id), eq(tables.writes.status, "pending")))
        .run();
    },
    finish: (id) => {
      self.database.orm
        .update(tables.writes)
        .set({ status: "applied", updated_at: Date.now() })
        .where(and(eq(tables.writes.id, id), eq(tables.writes.status, "pending")))
        .run();
    },
  };
}

function writeStoreOperation(self: WriteStoreData, task: string, revision: number, id?: string) {
  const row = self.database.orm
    .select()
    .from(tables.activity)
    .where(
      and(
        eq(tables.activity.id, id ?? ""),
        eq(tables.activity.task, task),
        eq(tables.activity.revision, revision),
        eq(tables.activity.actor, "worker"),
        eq(tables.activity.kind, "tool"),
        eq(tables.activity.status, "running"),
      ),
    )
    .get();
  if (
    !row ||
    ![TOOL_NAMES.edit, TOOL_NAMES.create].some((name) => row.title.startsWith(`${name} · `))
  ) {
    return undefined;
  }
  const input = z
    .object({ description: z.string().nullish() })
    .parse(JSON.parse(row.input ?? "{}"));
  return { id: row.id, description: input.description ?? null };
}

async function writeStoreCurrentHash(self: WriteStoreData, path: string): Promise<string | null> {
  const parent = await realpath(dirname(path));
  if (!inside(self.database.root, resolve(parent, basename(path)))) {
    throw new Error("Interrupted write path moved outside project");
  }
  try {
    const canonical = await realpath(path);
    if (!inside(self.database.root, canonical)) {
      throw new Error("Interrupted write now points outside project");
    }
    return hash(await readFile(canonical));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
    return null;
  }
}

async function writeStoreReconcile(
  self: WriteStoreData,
  allowConflicts = false,
): Promise<string[]> {
  const rows = self.database.orm
    .select()
    .from(tables.writes)
    .where(inArray(tables.writes.status, ["pending", "conflict"]))
    .all();
  const conflicts: string[] = await createDirectoryStore(self.database).reconcile();
  for (const row of rows) {
    const write = z
      .object({
        id: z.string(),
        path: z.string(),
        before_hash: z.string().nullable(),
        after_hash: z.string(),
      })
      .parse(row);
    const current = await writeStoreCurrentHash(self, write.path);
    let status = "conflict";
    if (current === write.after_hash) {
      status = "applied";
    } else if (current === write.before_hash) {
      status = "retryable";
    }
    self.database.transaction(() => {
      self.database.orm
        .update(tables.writes)
        .set({ status, updated_at: Date.now() })
        .where(eq(tables.writes.id, write.id))
        .run();
      self.database.event("write_reconciled", write.id, { path: write.path, status });
    });
    if (status === "conflict") {
      conflicts.push(write.path);
    }
  }
  if (conflicts.length && !allowConflicts) {
    throw new Error(
      `Interrupted writes conflict with current source: ${conflicts.join(", ")}. No writes were replayed.`,
    );
  }
  return conflicts;
}
