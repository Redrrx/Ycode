import { and, desc, eq, gte, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { z } from "zod";
import { iterateRows, type ProjectDatabase } from "./database.ts";
import type { historyRequestSchema } from "./schema.ts";
import { tables } from "./tables.ts";
const rowSchema = z.object({
  id: z.string(),
  sequence: z.number(),
  task: z.string(),
  revision: z.number(),
  path: z.string(),
  description: z.string(),
  searchDescription: z.string(),
  status: z.string(),
  before_hash: z.string().nullable(),
  after_hash: z.string().nullable(),
  kind: z.enum(["file", "directory"]),
  created_at: z.number(),
  updated_at: z.number(),
  operation_id: z.string().nullable(),
});
export type ChangeRow = z.infer<typeof rowSchema>;
export const cursorSchema = z.object({
  version: z.literal(2),
  at: z.number(),
  sequence: z.number().int().positive(),
  filter: z.string(),
});
type Request = z.infer<typeof historyRequestSchema>;

export function changeAction(row: ChangeRow) {
  if (row.kind === "directory") {
    return "mkdir";
  }
  return row.before_hash === null ? "create" : "edit";
}

function description(text: string, spec: string | null): string | undefined {
  if (text) {
    return text;
  }
  return spec
    ? z.object({ objective: z.string().optional() }).parse(JSON.parse(spec)).objective
    : undefined;
}

function filters(
  t: typeof tables.writes | typeof tables.directories,
  request: Request,
  offset: number,
  id?: string,
  cursor?: z.infer<typeof cursorSchema>,
) {
  const time = t.created_at;
  return and(
    id === undefined ? undefined : eq(t.id, id),
    request.task ? eq(t.task, request.task) : undefined,
    request.status ? eq(t.status, request.status) : undefined,
    request.since ? gte(t.created_at, Date.parse(request.since)) : undefined,
    request.until ? lte(t.created_at, Date.parse(request.until)) : undefined,
    cursor
      ? or(
          lt(time, cursor.at),
          and(eq(time, cursor.at), lt(t.sequence, (cursor.sequence - offset) / 2)),
        )
      : undefined,
  );
}

function* fileRows(
  database: ProjectDatabase,
  request: Request,
  id?: string,
  cursor?: z.infer<typeof cursorSchema>,
): Generator<ChangeRow, void> {
  if (request.action === "mkdir") {
    return;
  }
  const t = tables.writes;
  const query = database.orm
    .select({ row: t, spec: tables.tasks.spec })
    .from(t)
    .leftJoin(tables.tasks, eq(tables.tasks.id, t.task))
    .where(
      and(
        filters(t, request, 0, id, cursor),
        request.action === "create" ? isNull(t.before_hash) : undefined,
        request.action === "edit" ? isNotNull(t.before_hash) : undefined,
      ),
    )
    .orderBy(desc(t.created_at), desc(t.sequence));
  for (const { row, spec } of iterateRows(query)) {
    const summary = description(row.description, spec);
    yield rowSchema.parse({
      ...row,
      sequence: z.number().parse(row.sequence) * 2,
      kind: "file",
      description: summary ?? "Recorded change",
      searchDescription: summary ?? "",
    });
  }
}

function* directoryRows(
  database: ProjectDatabase,
  request: Request,
  id?: string,
  cursor?: z.infer<typeof cursorSchema>,
): Generator<ChangeRow, void> {
  if (request.action && request.action !== "mkdir") {
    return;
  }
  const t = tables.directories;
  const query = database.orm
    .select({ row: t, spec: tables.tasks.spec })
    .from(t)
    .leftJoin(tables.tasks, eq(tables.tasks.id, t.task))
    .where(filters(t, request, 1, id, cursor))
    .orderBy(desc(t.created_at), desc(t.sequence));
  for (const { row, spec } of iterateRows(query)) {
    const summary = description(row.description, spec);
    yield rowSchema.parse({
      ...row,
      sequence: z.number().parse(row.sequence) * 2 + 1,
      kind: "directory",
      description: summary ?? "Recorded change",
      searchDescription: summary ?? "",
      before_hash: null,
      after_hash: null,
      operation_id: null,
    });
  }
}

function newer(a: ChangeRow, b: ChangeRow): boolean {
  return a.created_at > b.created_at || (a.created_at === b.created_at && a.sequence > b.sequence);
}

export function* changeRows(
  database: ProjectDatabase,
  id?: string,
  request: Request = {},
  cursor?: z.infer<typeof cursorSchema>,
): Generator<ChangeRow, void> {
  const files = fileRows(database, request, id, cursor);
  const directories = directoryRows(database, request, id, cursor);
  try {
    let a = files.next().value;
    let b = directories.next().value;
    while (a || b) {
      if (a && (!b || newer(a, b))) {
        yield a;
        a = files.next().value;
      } else if (b) {
        yield b;
        b = directories.next().value;
      }
    }
  } finally {
    files.return(undefined);
    directories.return(undefined);
  }
}

const lower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
function matches(row: ChangeRow, request: Request): boolean {
  if (request.path && !lower(row.path).includes(lower(request.path))) {
    return false;
  }
  const text = lower(`${row.path} ${row.searchDescription} ${row.task}`);
  return (request.query?.trim().split(/\s+/u).filter(Boolean) ?? []).every((word) =>
    text.includes(lower(word)),
  );
}

export function findChanges(
  database: ProjectDatabase,
  request: Request,
  filter: string,
  limit: number,
): ChangeRow[] {
  const cursor = request.cursor
    ? cursorSchema.parse(JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")))
    : undefined;
  if (cursor && cursor.filter !== filter) {
    throw new Error("History filters changed; restart without cursor");
  }
  const result: ChangeRow[] = [];
  for (const row of changeRows(database, undefined, request, cursor)) {
    if (matches(row, request)) {
      result.push(row);
    }
    if (result.length === limit) {
      break;
    }
  }
  return result;
}
