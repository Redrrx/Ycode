import { and, desc, eq } from "drizzle-orm";
import { resolve } from "node:path";
import { z } from "zod";
import { encode, type ProjectDatabase } from "./database.ts";
import type { ProjectTask } from "./schema.ts";
import { checkDefinitionSchema, type CheckDefinition } from "./schema.ts";
import { tables } from "./tables.ts";
const requestSchema = checkDefinitionSchema
  .omit({ name: true })
  .extend({ check: z.string().optional() })
  .strip();
const resultSchema = z.object({
  definition: z.string(),
  source_epoch: z.number(),
  status: z.string(),
});

interface VerificationStoreData {
  readonly database: ProjectDatabase;
}

export type VerificationStore = Omit<ReturnType<typeof bindVerificationStore>, "database">;

export function createVerificationStore(database: ProjectDatabase): VerificationStore {
  return bindVerificationStore({ database });
}

function bindVerificationStore(self: VerificationStoreData) {
  return Object.assign(self, {
    epoch: verificationStoreEpoch.bind(undefined, self),
    invalidate: verificationStoreInvalidate.bind(undefined, self),
    definitions: verificationStoreDefinitions.bind(undefined, self),
    define: verificationStoreDefine.bind(undefined, self),
    validate: verificationStoreValidate.bind(undefined, self),
    begin: verificationStoreBegin.bind(undefined, self),
    finish: verificationStoreFinish.bind(undefined, self),
    passed: verificationStorePassed.bind(undefined, self),
    finalPassed: verificationStoreFinalPassed.bind(undefined, self),
    summary: verificationStoreSummary.bind(undefined, self),
  });
}

function verificationStoreEpoch(self: VerificationStoreData): number {
  return z
    .object({ source_epoch: z.number() })
    .parse(self.database.orm.select().from(tables.state).where(eq(tables.state.id, 1)).get())
    .source_epoch;
}

function verificationStoreInvalidate(self: VerificationStoreData): void {
  self.database.transaction(() => {
    self.database.orm
      .update(tables.state)
      .set({ source_epoch: verificationStoreEpoch(self) + 1 })
      .where(eq(tables.state.id, 1))
      .run();
  });
}

function verificationStoreDefinitions(self: VerificationStoreData): CheckDefinition[] {
  return self.database.orm
    .select()
    .from(tables.checks)
    .orderBy(tables.checks.name)
    .all()
    .map((row) =>
      checkDefinitionSchema.parse(
        JSON.parse(z.object({ definition: z.string() }).parse(row).definition),
      ),
    );
}

function verificationStoreDefine(self: VerificationStoreData, checks: CheckDefinition[]): void {
  if (new Set(checks.map((check) => check.name)).size !== checks.length) {
    throw new Error("Duplicate repository check name");
  }
  self.database.orm.delete(tables.checks).run();
  for (const check of checks) {
    self.database.orm
      .insert(tables.checks)
      .values({ name: check.name, definition: encode(checkDefinitionSchema.parse(check)) })
      .run();
  }
}

function verificationStoreValidate(
  self: VerificationStoreData,
  input: unknown,
): CheckDefinition | undefined {
  const request = requestSchema.parse(input);
  const definition = verificationStoreDefinitions(self).find(
    (check) => check.name === request.check,
  );
  if (!definition) {
    return undefined;
  }
  const actual = { ...request, cwd: resolve(self.database.root, request.cwd) };
  const expected = { ...definition, cwd: resolve(self.database.root, definition.cwd) };
  if (
    actual.command !== expected.command ||
    actual.cwd !== expected.cwd ||
    actual.network !== expected.network ||
    actual.writable !== expected.writable
  ) {
    throw new Error(`Check ${definition.name} does not match its saved command`);
  }
  return definition;
}

function verificationStoreBegin(self: VerificationStoreData, run: string, input: unknown): void {
  const definition = verificationStoreValidate(self, input);
  if (definition) {
    self.database.orm
      .insert(tables.checkResults)
      .values({
        run,
        name: definition.name,
        definition: encode(definition),
        source_epoch: verificationStoreEpoch(self),
        status: "running",
      })
      .run();
  }
}

function verificationStoreFinish(
  self: VerificationStoreData,
  run: string,
  status: string,
  writable = false,
): void {
  const saved = self.database.orm
    .select()
    .from(tables.checkResults)
    .where(eq(tables.checkResults.run, run))
    .get();
  const epoch = verificationStoreEpoch(self);
  const unchanged = saved && saved.source_epoch + Number(writable) === epoch;
  self.database.orm
    .update(tables.checkResults)
    .set({ status, ...(unchanged ? { source_epoch: epoch } : {}) })
    .where(eq(tables.checkResults.run, run))
    .run();
}

function verificationStorePassed(self: VerificationStoreData, task: ProjectTask): boolean {
  if (!task.spec.checks.length) {
    return true;
  }
  const report = z
    .object({
      commandChecks: z
        .array(z.object({ check: z.string(), run: z.string(), generation: z.int().nonnegative() }))
        .default([]),
    })
    .safeParse(JSON.parse(task.result ?? "null"));
  if (!report.success) {
    return false;
  }
  return task.spec.checks.every((name) =>
    report.data.commandChecks.some(
      (check) => check.check === name && verificationStorePassedRun(self, check.run, task, name),
    ),
  );
}

function verificationStorePassedRun(
  self: VerificationStoreData,
  run: string,
  task: ProjectTask,
  name: string,
): boolean {
  const row = self.database.orm
    .select()
    .from(tables.commands)
    .where(
      and(
        eq(tables.commands.id, run),
        eq(tables.commands.task, task.id),
        eq(tables.commands.revision, task.revision),
        eq(tables.commands.status, "passed"),
        eq(tables.commands.exit_code, 0),
      ),
    )
    .get();
  return (
    row !== undefined &&
    z.object({ check: z.string().optional() }).parse(JSON.parse(row.command)).check === name
  );
}

function verificationStoreFinalPassed(self: VerificationStoreData, task: ProjectTask): boolean {
  if (!verificationStorePassed(self, task) || !task.spec.checks.length) {
    return false;
  }
  const running = self.database.orm
    .select({ id: tables.commands.id })
    .from(tables.commands)
    .where(eq(tables.commands.status, "running"))
    .limit(1)
    .get();
  if (running) {
    return false;
  }
  const reported = z
    .object({ commandChecks: z.array(z.object({ check: z.string(), run: z.string() })) })
    .parse(JSON.parse(task.result ?? "null")).commandChecks;
  const definitions = verificationStoreDefinitions(self);
  const epoch = verificationStoreEpoch(self);
  return task.spec.checks.every((name) => {
    const definition = definitions.find((check) => check.name === name);
    const latest = self.database.orm
      .select()
      .from(tables.checkResults)
      .where(eq(tables.checkResults.name, name))
      .orderBy(desc(tables.checkResults.sequence))
      .limit(1)
      .get();
    return (
      definition !== undefined &&
      latest !== undefined &&
      latest.status === "passed" &&
      latest.source_epoch === epoch &&
      latest.definition === encode(definition) &&
      reported.some((check) => check.check === name && check.run === latest.run) &&
      verificationStorePassedRun(self, latest.run, task, name)
    );
  });
}

function verificationStoreSummary(self: VerificationStoreData) {
  const epoch = verificationStoreEpoch(self);
  return verificationStoreDefinitions(self).map((definition) => {
    const row = self.database.orm
      .select()
      .from(tables.checkResults)
      .where(eq(tables.checkResults.name, definition.name))
      .orderBy(desc(tables.checkResults.sequence))
      .limit(1)
      .get();
    if (!row) {
      return { name: definition.name, status: "not-run" };
    }
    const result = resultSchema.parse(row);
    const changed = result.source_epoch !== epoch || result.definition !== encode(definition);
    return {
      name: definition.name,
      status: result.status,
      freshness: changed ? "stale" : "unknown",
    };
  });
}
