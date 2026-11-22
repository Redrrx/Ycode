import { and, desc, eq, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { redact, safeText } from "../activity/data.ts";
import { encode, type ProjectDatabase } from "./database.ts";
import { tables } from "./tables.ts";
import { createVerificationStore } from "./verification.ts";
export interface RecordedCheck {
  check: string;
  run: string;
  generation: number;
}

export interface CommandOutcome {
  status: "running" | "passed" | "failed" | "cancelled" | "timeout" | "interrupted";
  exitCode: number | null;
  signal: string | null;
  endedAt: number | null;
}

interface ExecutionStoreData {
  readonly database: ProjectDatabase;
  readonly task: string;
  readonly revision: number;
}

export type ExecutionStore = Omit<
  ReturnType<typeof bindExecutionStore>,
  "database" | "task" | "revision"
>;

export function createExecutionStore(
  database: ProjectDatabase,
  task: string,
  revision: number,
): ExecutionStore {
  return bindExecutionStore({ database, task, revision });
}

function bindExecutionStore(self: ExecutionStoreData) {
  return Object.assign(self, {
    begin: executionStoreBegin.bind(undefined, self),
    append: executionStoreAppend.bind(undefined, self),
    finish: executionStoreFinish.bind(undefined, self),
    result: executionStoreResult.bind(undefined, self),
    logs: executionStoreLogs.bind(undefined, self),
    tail: executionStoreTail.bind(undefined, self),
  });
}

function executionStoreBegin(self: ExecutionStoreData, command: unknown, cwd: string): string {
  return self.database.transaction(() => {
    const verification = createVerificationStore(self.database);
    verification.validate(command);
    if (z.object({ writable: z.boolean().optional() }).parse(command).writable) {
      verification.invalidate();
    }
    const id = randomUUID();
    self.database.orm
      .insert(tables.commands)
      .values({
        id,
        task: self.task,
        revision: self.revision,
        started: Date.now(),
        cwd,
        command: redact(encode(command)),
        status: "running",
      })
      .run();
    verification.begin(id, command);
    return id;
  });
}

function executionStoreAppend(
  self: ExecutionStoreData,
  id: string,
  stream: string,
  text: string,
): void {
  self.database.orm
    .insert(tables.logs)
    .values({ run: id, stream, text: safeText(redact(text)) })
    .run();
}

function executionStoreFinish(self: ExecutionStoreData, id: string, outcome: CommandOutcome): void {
  self.database.transaction(() => {
    const run = executionStoreResult(self, id);
    const verification = createVerificationStore(self.database);
    const writable =
      z.object({ writable: z.boolean().optional() }).parse(JSON.parse(run.command)).writable ??
      false;
    if (writable) {
      verification.invalidate();
    }
    verification.finish(id, outcome.status, writable);
    self.database.orm
      .update(tables.commands)
      .set({
        status: outcome.status,
        exit_code: outcome.exitCode,
        signal: outcome.signal,
        ended: outcome.endedAt,
      })
      .where(
        and(
          eq(tables.commands.id, id),
          eq(tables.commands.task, self.task),
          eq(tables.commands.revision, self.revision),
        ),
      )
      .run();
  });
}

function executionStoreResult(self: ExecutionStoreData, id: string) {
  const row = self.database.orm
    .select()
    .from(tables.commands)
    .where(
      and(
        eq(tables.commands.id, id),
        eq(tables.commands.task, self.task),
        eq(tables.commands.revision, self.revision),
      ),
    )
    .get();
  if (!row) {
    throw new Error("Unknown command for this task revision");
  }
  return z
    .object({
      id: z.string(),
      started: z.number(),
      ended: z.number().nullable(),
      cwd: z.string(),
      command: z.string(),
      status: z.string(),
      exit_code: z.number().nullable(),
      signal: z.string().nullable(),
    })
    .parse(row);
}

function executionStoreLogs(self: ExecutionStoreData, id: string, cursor = 0) {
  executionStoreResult(self, id);
  const rows = self.database.orm
    .select()
    .from(tables.logs)
    .where(and(eq(tables.logs.run, id), gt(tables.logs.seq, cursor)))
    .orderBy(tables.logs.seq)
    .limit(17)
    .all()
    .map((row) => z.object({ seq: z.number(), stream: z.string(), text: z.string() }).parse(row));
  const visible: (typeof rows)[number][] = [];
  let size = 0;
  for (const row of rows.slice(0, 16)) {
    if (size + Buffer.byteLength(row.text) > 12000 && visible.length) {
      break;
    }
    visible.push(row);
    size += Buffer.byteLength(row.text);
  }
  return {
    chunks: visible,
    nextCursor: rows.length > visible.length ? (visible.at(-1)?.seq ?? null) : null,
  };
}

function executionStoreTail(self: ExecutionStoreData, id: string): string {
  return self.database.orm
    .select({ text: tables.logs.text })
    .from(tables.logs)
    .where(eq(tables.logs.run, id))
    .orderBy(desc(tables.logs.seq))
    .limit(8)
    .all()
    .map((row) => z.object({ text: z.string() }).parse(row).text)
    .reverse()
    .join("")
    .slice(-12000);
}
