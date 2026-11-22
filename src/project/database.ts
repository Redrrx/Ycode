import { getAgentDir } from "@earendil-works/pi-coding-agent";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { STORAGE_DIRECTORY } from "../config/constants.ts";
import { tables } from "./tables.ts";
export function encode(value: unknown): string {
  return (
    JSON.stringify(value, (key, item: unknown) =>
      /^(?:api.?key|authorization|password|secret|access.?token|refresh.?token)$/iu.test(key)
        ? "[redacted]"
        : item,
    ) ?? "null"
  );
}

export function* iterateRows<T>(query: {
  limit(size: number): { offset(start: number): { all(): T[] } };
}): Generator<T, void> {
  for (let offset = 0; ; offset += 128) {
    const rows = query.limit(128).offset(offset).all();
    yield* rows;
    if (rows.length < 128) {
      return;
    }
  }
}

const DATABASE_VERSION = 11;

function databaseVersion(connection: Database.Database): number {
  const version = z.number().parse(connection.pragma("user_version", { simple: true }));
  if (version === DATABASE_VERSION) {
    return version;
  }
  const tables = z
    .array(z.object({ schema: z.string(), name: z.string() }))
    .parse(connection.pragma("table_list"));
  if (
    version === 0 &&
    !tables.some((table) => table.schema === "main" && !table.name.startsWith("sqlite_"))
  ) {
    return 0;
  }
  throw new Error(
    `Unsupported Ycode database format ${version}; expected ${DATABASE_VERSION}: ${connection.name}. Use a new tracking database or the matching Ycode version. Stored data was not migrated.`,
  );
}

function initializeDatabase(connection: Database.Database, orm: ReturnType<typeof drizzle>): void {
  connection
    .transaction(() => {
      if (databaseVersion(connection) === DATABASE_VERSION) {
        return;
      }
      const statements = z
        .array(z.string())
        .min(1)
        .parse(JSON.parse(readFileSync(new URL("./schema.json", import.meta.url), "utf8")));
      statements.forEach((statement) => orm.run(sql.raw(statement)));
      orm.insert(tables.state).values({ id: 1 }).run();
      connection.pragma(`user_version=${DATABASE_VERSION}`);
    })
    .immediate();
}

interface ProjectDatabaseData {
  readonly orm: ReturnType<typeof drizzle>;
  readonly root: string;
  session: string;
  connection: Database.Database;
}

export type ProjectDatabase = ReturnType<typeof bindProjectDatabase>;

export function createProjectDatabase(path: string, root: string): ProjectDatabase {
  const connection: Database.Database = new Database(path, { timeout: 5000 });
  const orm: ReturnType<typeof drizzle> = drizzle(connection);
  try {
    databaseVersion(connection);
    connection.pragma("journal_mode=WAL");
    connection.pragma("synchronous=FULL");
    connection.pragma("foreign_keys=ON");
    initializeDatabase(connection, orm);
  } catch (error) {
    connection.close();
    throw error;
  }

  return bindProjectDatabase({
    orm,
    root,
    session: "",
    connection,
  });
}

function bindProjectDatabase(self: ProjectDatabaseData) {
  return Object.assign(self, {
    transaction: <T>(action: () => T) => projectDatabaseTransaction<T>(self, action),
    event: projectDatabaseEvent.bind(undefined, self),
    goal: projectDatabaseGoal.bind(undefined, self),
    constraints: projectDatabaseConstraints.bind(undefined, self),
    close: projectDatabaseClose.bind(undefined, self),
  });
}

export async function openProjectDatabase(cwd: string): Promise<ProjectDatabase> {
  const root = await realpath(cwd);
  const directory = join(
    getAgentDir(),
    STORAGE_DIRECTORY,
    "projects",
    createHash("sha256").update(root).digest("hex"),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return createProjectDatabase(join(directory, "project.sqlite"), root);
}

function projectDatabaseTransaction<T>(self: ProjectDatabaseData, action: () => T): T {
  return self.connection.transaction(action).immediate();
}

function projectDatabaseEvent(
  self: ProjectDatabaseData,
  kind: string,
  subject: string,
  payload: unknown,
): void {
  self.orm
    .insert(tables.history)
    .values({ at: Date.now(), session: self.session, kind, subject, payload: encode(payload) })
    .run();
}

function projectDatabaseGoal(self: ProjectDatabaseData): string | undefined {
  return self.orm.select().from(tables.project).where(eq(tables.project.id, 1)).get()?.goal;
}

function projectDatabaseConstraints(self: ProjectDatabaseData): string[] {
  const row = self.orm.select().from(tables.project).where(eq(tables.project.id, 1)).get();
  return row ? z.array(z.string()).parse(JSON.parse(row.constraints)) : [];
}

function projectDatabaseClose(self: ProjectDatabaseData): void {
  self.connection.close();
}
