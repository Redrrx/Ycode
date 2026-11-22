import { and, eq } from "drizzle-orm";
import { relative } from "node:path";
import { z } from "zod";
import { redact, safeText } from "../activity/data.ts";
import { TOOL_NAMES } from "../config/constants.ts";
import { changeAction, changeRows, findChanges, type ChangeRow } from "./change-query.ts";
import { encode, type ProjectDatabase } from "./database.ts";
import { historyRequestSchema } from "./schema.ts";
import { tables } from "./tables.ts";
export const changeHeadSchema = z.object({
  id: z.string(),
  at: z.string(),
  action: z.enum(["create", "edit", "mkdir"]),
  path: z.string(),
  description: z.string(),
  status: z.string(),
  task: z.string(),
  revision: z.number(),
});
export const changePageSchema = z.object({
  changes: z.array(changeHeadSchema),
  nextCursor: z.string().nullable(),
});
type Request = z.infer<typeof historyRequestSchema>;

function validateLookup(request: Request): void {
  if ((request.view || request.offset !== undefined) && !request.changeId) {
    throw new Error("view/offset require changeId");
  }
  if (
    request.changeId &&
    Object.keys(request).some((key) => !["changeId", "offset", "view"].includes(key))
  ) {
    throw new Error("Select changeId with optional view/offset only");
  }
}

function decoded(text: string | null): unknown {
  return JSON.parse(text ?? "null");
}

interface ChangeHistoryData {
  readonly database: ProjectDatabase;
}

export type ChangeHistory = Omit<ReturnType<typeof bindChangeHistory>, "database">;

export function createChangeHistory(database: ProjectDatabase): ChangeHistory {
  return bindChangeHistory({ database });
}

function bindChangeHistory(self: ChangeHistoryData) {
  return Object.assign(self, {
    list: changeHistoryList.bind(undefined, self),
    detail: changeHistoryDetail.bind(undefined, self),
    lookup: changeHistoryLookup.bind(undefined, self),
  });
}

function changeHistoryHead(self: ChangeHistoryData, row: ChangeRow) {
  return changeHeadSchema.parse({
    id: row.id,
    at: new Date(row.created_at).toISOString(),
    action: changeAction(row),
    path: relative(self.database.root, row.path),
    description: safeText(redact(row.description)).replaceAll("\n", " ").slice(0, 240),
    status: row.status,
    task: row.task,
    revision: row.revision,
  });
}

function changeHistoryPage(self: ChangeHistoryData, rows: ChangeRow[], limit: number) {
  const visible = rows.slice(0, limit);
  while (
    visible.length > 1 &&
    encode(visible.map((row) => changeHistoryHead(self, row))).length > 10000
  ) {
    visible.pop();
  }
  return visible;
}

function changeHistoryList(self: ChangeHistoryData, request: Request) {
  const filter = encode({
    query: request.query,
    path: request.path,
    task: request.task,
    action: request.action,
    status: request.status,
    since: request.since,
    until: request.until,
  });
  const limit = request.limit ?? 8;
  const rows = self.database.transaction(() =>
    findChanges(self.database, request, filter, limit + 1),
  );
  const visible = changeHistoryPage(self, rows, limit);
  const last = visible.at(-1);
  const nextCursor =
    rows.length > visible.length && last
      ? Buffer.from(
          encode({ version: 2, at: last.created_at, sequence: last.sequence, filter }),
        ).toString("base64url")
      : null;
  return {
    changes: visible.map((row) => changeHistoryHead(self, row)),
    nextCursor,
    order: "newest_first",
    note: "Ycode write attempts only. History is not current source or a Git diff.",
  };
}

function changeHistoryDetail(self: ChangeHistoryData, id: string, mutation = true): unknown {
  const rows = changeRows(self.database, id);
  const row = rows.next().value;
  rows.return(undefined);
  if (!row) {
    return { change: null };
  }
  const operation = row.operation_id && mutation ? changeHistoryOperation(self, row) : undefined;
  const io = z
    .object({ input: z.string().nullable(), output: z.string().nullable() })
    .optional()
    .parse(operation);
  return {
    change: changeHistoryHead(self, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    operation: io
      ? {
          id: row.operation_id,
          input: decoded(io.input),
          output: decoded(io.output),
        }
      : null,
    note: "Selected change only. Use view=mutation for linked mutation input/output; long mutation details support offset. Inspect current source before edits; Git owns version history.",
  };
}

function changeHistoryOperation(self: ChangeHistoryData, row: ChangeRow) {
  const result = self.database.orm
    .select()
    .from(tables.activity)
    .where(
      and(
        eq(tables.activity.id, row.operation_id ?? ""),
        eq(tables.activity.task, row.task),
        eq(tables.activity.revision, row.revision),
        eq(tables.activity.actor, "worker"),
        eq(tables.activity.kind, "tool"),
      ),
    )
    .get();
  return result &&
    [TOOL_NAMES.edit, TOOL_NAMES.create].some((name) => result.title.startsWith(`${name} · `))
    ? result
    : undefined;
}

function changeHistoryLookup(self: ChangeHistoryData, input: Request): string {
  const request = historyRequestSchema.parse(input);
  validateLookup(request);
  const result = request.changeId
    ? changeHistoryDetail(self, request.changeId, request.view === "mutation")
    : changeHistoryList(self, request);
  const text = encode(result);
  const offset = request.offset ?? 0;
  if (!request.changeId || (text.length <= 12000 && offset === 0)) {
    return text;
  }
  const end = Math.min(offset + 12000, text.length);
  return encode({
    changeId: request.changeId,
    text: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    totalChars: text.length,
  });
}
