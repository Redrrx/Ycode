import { eq } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
const sequence = () => integer("rowid");
export const tables = {
  project: sqliteTable(
    "project",
    {
      id: integer().primaryKey(),
      goal: text().notNull(),
      constraints: text().notNull().default("[]"),
    },
    (t) => [check("project_singleton", eq(t.id, 1).inlineParams())],
  ),
  milestones: sqliteTable("milestones", {
    id: text().primaryKey(),
    objective: text().notNull(),
    status: text().notNull(),
    dependencies: text().notNull().default("[]"),
    sequence: sequence(),
  }),
  tasks: sqliteTable("tasks", {
    id: text().primaryKey(),
    milestone: text()
      .notNull()
      .references((): AnySQLiteColumn => tables.milestones.id),
    revision: integer().notNull(),
    spec: text().notNull(),
    status: text().notNull(),
    result: text(),
    position: integer().notNull().default(0),
    sequence: sequence(),
  }),
  history: sqliteTable(
    "history",
    {
      seq: integer().primaryKey({ autoIncrement: true }),
      at: integer().notNull(),
      session: text().notNull(),
      kind: text().notNull(),
      subject: text().notNull(),
      payload: text().notNull(),
    },
    (t) => [index("history_subject").on(t.subject, t.seq)],
  ),
  activity: sqliteTable(
    "activity",
    {
      id: text().primaryKey(),
      task: text().notNull(),
      revision: integer(),
      run: text().notNull(),
      parent: text(),
      actor: text().notNull(),
      kind: text().notNull(),
      title: text().notNull(),
      started: integer().notNull(),
      ended: integer(),
      status: text().notNull(),
      input: text(),
      output: text(),
      sequence: sequence(),
    },
    (t) => [index("activity_task").on(t.task, t.started)],
  ),
  writes: sqliteTable(
    "writes",
    {
      id: text().primaryKey(),
      task: text().notNull(),
      revision: integer().notNull(),
      path: text().notNull(),
      before_hash: text(),
      after_hash: text().notNull(),
      status: text().notNull(),
      created_at: integer().notNull(),
      updated_at: integer().notNull(),
      description: text().notNull().default(""),
      operation_id: text(),
      sequence: sequence(),
    },
    (t) => [index("writes_created").on(t.created_at)],
  ),
  workspaces: sqliteTable("workspaces", { id: text().primaryKey(), data: text().notNull() }),
  lease: sqliteTable(
    "lease",
    {
      id: integer().primaryKey(),
      owner: text().notNull(),
      pid: integer().notNull(),
    },
    (t) => [check("lease_singleton", eq(t.id, 1).inlineParams())],
  ),
  mainResponses: sqliteTable(
    "main_responses",
    {
      session: text().notNull(),
      timestamp: integer().notNull(),
      text: text().notNull(),
      metadata: text().notNull(),
      issue: text(),
    },
    (t) => [primaryKey({ columns: [t.session, t.timestamp] })],
  ),
  commands: sqliteTable(
    "command_runs",
    {
      id: text().primaryKey(),
      task: text().notNull(),
      revision: integer().notNull(),
      started: integer().notNull(),
      ended: integer(),
      cwd: text().notNull(),
      command: text().notNull(),
      status: text().notNull(),
      exit_code: integer(),
      signal: text(),
    },
    (t) => [index("command_task").on(t.task, t.revision, t.started)],
  ),
  logs: sqliteTable(
    "command_logs",
    {
      seq: integer().primaryKey({ autoIncrement: true }),
      run: text()
        .notNull()
        .references((): AnySQLiteColumn => tables.commands.id),
      stream: text().notNull(),
      text: text().notNull(),
    },
    (t) => [index("command_log_run").on(t.run, t.seq)],
  ),
  directories: sqliteTable("directory_changes", {
    id: text().primaryKey(),
    task: text().notNull(),
    revision: integer().notNull(),
    path: text().notNull(),
    status: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    description: text().notNull(),
    sequence: sequence(),
  }),
  preferences: sqliteTable("preferences", { key: text().primaryKey(), value: text().notNull() }),
  state: sqliteTable(
    "work_state",
    {
      id: integer().primaryKey(),
      selected: text().references((): AnySQLiteColumn => tables.tasks.id),
      source_epoch: integer().notNull().default(0),
      run: text(),
    },
    (t) => [check("state_singleton", eq(t.id, 1).inlineParams())],
  ),
  checks: sqliteTable("check_definitions", {
    name: text().primaryKey(),
    definition: text().notNull(),
  }),
  checkResults: sqliteTable("check_results", {
    run: text()
      .primaryKey()
      .references((): AnySQLiteColumn => tables.commands.id),
    name: text().notNull(),
    definition: text().notNull(),
    source_epoch: integer().notNull(),
    status: text().notNull(),
    sequence: sequence(),
  }),
};
