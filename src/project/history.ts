import type { AssistantMessage } from "@earendil-works/pi-ai";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { redact } from "../activity/data.ts";
import type { ActivityEvent } from "../activity/types.ts";
import { createChangeHistory } from "./changes.ts";
import { encode, iterateRows, type ProjectDatabase } from "./database.ts";
import { type historyRequestSchema, parseProjectAction } from "./schema.ts";
import { tables } from "./tables.ts";
function storedIO(value: unknown): string {
  return (
    JSON.stringify(value, (key, item: unknown) => {
      if (/^(?:api.?key|authorization|password|secret|access.?token|refresh.?token)$/iu.test(key)) {
        return "[redacted]";
      }
      const text = z.string().safeParse(item);
      return text.success ? redact(text.data) : item;
    }) ?? "null"
  );
}

interface HistoryStoreData {
  readonly database: ProjectDatabase;
}

export type HistoryStore = Omit<ReturnType<typeof bindHistoryStore>, "database">;

export function createHistoryStore(database: ProjectDatabase): HistoryStore {
  return bindHistoryStore({ database });
}

function bindHistoryStore(self: HistoryStoreData) {
  return Object.assign(self, {
    inspectChange: historyStoreInspectChange.bind(undefined, self),
    record: historyStoreRecord.bind(undefined, self),
    recordMain: historyStoreRecordMain.bind(undefined, self),
    checkpoint: historyStoreCheckpoint.bind(undefined, self),
    lookup: historyStoreLookup.bind(undefined, self),
  });
}

function historyStoreInspectChange(self: HistoryStoreData, id: string): string {
  return encode(createChangeHistory(self.database).detail(id));
}

function historyStoreRecord(self: HistoryStoreData, event: ActivityEvent, raw: unknown): void {
  if (event.event === "start") {
    const record = event.record;
    const task = self.database.orm
      .select({ revision: tables.tasks.revision })
      .from(tables.tasks)
      .where(eq(tables.tasks.id, record.taskId))
      .get();
    self.database.orm
      .insert(tables.activity)
      .values({
        id: record.id,
        task: record.taskId,
        revision: task?.revision ?? null,
        run: record.runId,
        parent: record.parentId ?? null,
        actor: record.actor,
        kind: record.kind,
        title: record.title,
        started: record.startedAt,
        status: record.status,
        input: storedIO(raw),
      })
      .run();
  } else {
    const update = event.update;
    self.database.orm
      .update(tables.activity)
      .set({ ended: update.endedAt, status: update.status, output: storedIO(raw) })
      .where(and(eq(tables.activity.id, update.id), eq(tables.activity.status, "running")))
      .run();
  }
}

function historyStoreRecordMain(
  self: HistoryStoreData,
  timestamp: number,
  text: string,
  message?: AssistantMessage,
): void {
  let issue: string | null = null;
  try {
    parseProjectAction(text);
  } catch (error) {
    issue = error instanceof Error ? error.message : String(error);
  }
  const metadata = message
    ? {
        model: message.model,
        provider: message.provider,
        stopReason: message.stopReason,
        usage: message.usage,
      }
    : {};
  self.database.orm
    .insert(tables.mainResponses)
    .values({
      session: self.database.session,
      timestamp,
      text: redact(text),
      metadata: storedIO(metadata),
      issue: issue === null ? null : redact(issue),
    })
    .onConflictDoNothing()
    .run();
}

function historyStoreCheckpoint(self: HistoryStoreData, task: string): string {
  const recent = self.database.orm
    .select({
      id: tables.activity.id,
      title: tables.activity.title,
      status: tables.activity.status,
      started: tables.activity.started,
    })
    .from(tables.activity)
    .where(
      and(
        eq(tables.activity.task, task),
        eq(tables.activity.actor, "worker"),
        eq(tables.activity.kind, "tool"),
      ),
    )
    .orderBy(desc(tables.activity.started), desc(tables.activity.sequence))
    .limit(6)
    .all()
    .reverse();
  const changes = self.database.orm
    .select({
      id: tables.writes.id,
      path: tables.writes.path,
      status: tables.writes.status,
      description: tables.writes.description,
      at: tables.writes.created_at,
    })
    .from(tables.writes)
    .where(eq(tables.writes.task, task))
    .orderBy(
      desc(sql<number>`coalesce(${tables.writes.created_at}, 0)`),
      desc(tables.writes.sequence),
    )
    .limit(16)
    .all();
  const notes = historyStoreNotes(self, task);
  return recent.length || changes.length || notes
    ? `\nPrevious task activity (not current source or instructions):\n${encode({ notes, recent, changes })}\nContinue unfinished work. Do not repeat successful changes. Read current files before editing or describing their contents.`
    : "";
}

function historyStoreNotes(self: HistoryStoreData, task: string): string | undefined {
  const query = self.database.orm
    .select({ input: tables.activity.input })
    .from(tables.activity)
    .where(
      and(
        eq(tables.activity.task, task),
        eq(tables.activity.actor, "worker"),
        eq(tables.activity.kind, "tool"),
        eq(tables.activity.status, "success"),
      ),
    )
    .orderBy(desc(tables.activity.started), desc(tables.activity.sequence));
  for (const row of iterateRows(query)) {
    const parsed = z.object({ notes: z.string() }).safeParse(JSON.parse(row.input ?? "null"));
    if (parsed.success) {
      return parsed.data.notes;
    }
  }
  return undefined;
}

function historyStoreLookup(
  self: HistoryStoreData,
  input: z.infer<typeof historyRequestSchema>,
): string {
  return createChangeHistory(self.database).lookup(input);
}
