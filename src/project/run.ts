import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { encode, type ProjectDatabase } from "./database.ts";
import { checkDefinitionSchema, type ProjectTask, type reviewSchema } from "./schema.ts";
import { tables } from "./tables.ts";
import type { TaskStore } from "./tasks.ts";
import { createVerificationStore } from "./verification.ts";

const runSchema = z
  .object({
    id: z.string(),
    status: z.enum(["running", "paused", "completed", "cancelled"]),
    tasks: z
      .array(
        z
          .object({
            id: z.string(),
            revision: z.int().positive(),
            spec: z.string(),
            prerequisites: z.array(z.string()),
          })
          .strict(),
      )
      .min(1),
    verification: z.string(),
    current: z.string().optional(),
    goal: z.string().optional(),
    constraints: z.array(z.string()),
    checks: z.array(checkDefinitionSchema),
    reason: z.string().optional(),
  })
  .strict();
type PlanRun = z.infer<typeof runSchema>;

export function readRun(database: ProjectDatabase): PlanRun | undefined {
  const row = database.orm.select().from(tables.state).where(eq(tables.state.id, 1)).get();
  return row?.run ? runSchema.parse(JSON.parse(row.run)) : undefined;
}

function saveRun(database: ProjectDatabase, run: PlanRun): void {
  database.transaction(() => {
    database.orm
      .update(tables.state)
      .set({ run: encode(run) })
      .where(eq(tables.state.id, 1))
      .run();
    database.event("plan_run", run.id, run);
  });
}

export function openRun(database: ProjectDatabase): PlanRun | undefined {
  const run = readRun(database);
  return run && ["running", "paused"].includes(run.status) ? run : undefined;
}

export function changeRunStatus(
  database: ProjectDatabase,
  status: "running" | "paused" | "cancelled",
  reason?: string,
): void {
  const run = openRun(database);
  if (run) {
    saveRun(database, { ...run, status, reason });
  }
}

function savedTask(tasks: TaskStore, task: ProjectTask) {
  return {
    id: task.id,
    revision: task.revision,
    spec: encode(task.spec),
    prerequisites: tasks
      .dependencies()
      .prerequisites(task)
      .map((item) => item.id)
      .sort(),
  };
}

function requireTask(tasks: TaskStore, id: string): ProjectTask {
  const task = tasks.get(id);
  if (!task) {
    throw new Error(`Unknown task: ${id}`);
  }
  return task;
}

function runChecks(tasks: TaskStore, selected: ProjectTask[]) {
  const names = new Set(selected.flatMap((task) => task.spec.checks));
  const checks = createVerificationStore(tasks.database)
    .definitions()
    .filter((check) => names.has(check.name));
  if (checks.length !== names.size) {
    throw new Error("Every run check needs a saved command definition");
  }
  return checks;
}

function validateStart(tasks: TaskStore, selected: ProjectTask[], verification: string): void {
  if (openRun(tasks.database)) {
    throw new Error("Resume or cancel the existing run first");
  }
  if (tasks.tasks().some((task) => ["running", "finished"].includes(task.status))) {
    throw new Error("Review pending work before starting a run");
  }
  if (selected.some((task) => !["ready", "accepted"].includes(task.status))) {
    throw new Error("Run tasks must be ready or accepted; revise blocked tasks first");
  }
  const final = selected.find((task) => task.id === verification);
  if (
    !final ||
    final.status !== "ready" ||
    !final.spec.acceptance.length ||
    !final.spec.checks.length ||
    !final.spec.execution?.commands
  ) {
    throw new Error(
      "Select a ready final verification task with acceptance criteria and named checks",
    );
  }
  if (
    selected.some((task) => task.id !== verification && !final.spec.dependsOn?.includes(task.id))
  ) {
    throw new Error("Final verification must explicitly depend on every other run task");
  }
  if (selected.some((task) => task.spec.checks.some((name) => !final.spec.checks.includes(name)))) {
    throw new Error("Final verification must include every required run check");
  }
}

export function startRun(tasks: TaskStore, ids: string[], verification: string): void {
  const selected = ids.map((id) => requireTask(tasks, id));
  validateStart(tasks, selected, verification);
  const graph = tasks.dependencies();
  graph.validate();
  for (const task of selected) {
    const missing = graph
      .prerequisites(task)
      .filter((item) => item.status !== "accepted" && !ids.includes(item.id));
    if (missing.length) {
      throw new Error(
        `Include unfinished prerequisites: ${missing.map((item) => item.id).join(", ")}`,
      );
    }
  }
  saveRun(tasks.database, {
    id: randomUUID(),
    status: "running",
    tasks: selected.map((task) => savedTask(tasks, task)),
    verification,
    goal: tasks.database.goal(),
    constraints: tasks.database.constraints(),
    checks: runChecks(tasks, selected),
  });
}

function unchangedTasks(tasks: TaskStore, run: PlanRun): ProjectTask[] {
  const selected = run.tasks.map((item) => requireTask(tasks, item.id));
  const changed =
    encode(selected.map((task) => savedTask(tasks, task))) !== encode(run.tasks) ||
    tasks.database.goal() !== run.goal ||
    encode(tasks.database.constraints()) !== encode(run.constraints) ||
    encode(runChecks(tasks, selected)) !== encode(run.checks);
  if (changed) {
    throw new Error(
      "Run tasks, permissions, prerequisites, or checks changed. Cancel and authorize a new run",
    );
  }
  return selected;
}

export function nextRunTask(tasks: TaskStore): ProjectTask | undefined {
  const run = readRun(tasks.database);
  if (run?.status !== "running") {
    return undefined;
  }
  const selected = unchangedTasks(tasks, run);
  const pending = selected.filter((task) => task.status !== "accepted");
  const graph = tasks.dependencies();
  const current = pending.find((task) => task.id === run.current);
  const next = current ?? pending.find((task) => !graph.blockers(task).length);
  if (!next || graph.blockers(next).length || next.status === "stopped") {
    changeRunStatus(tasks.database, "paused", "No authorized task is ready");
    return undefined;
  }
  if (next.id === run.verification && pending.length !== 1) {
    throw new Error("Accept every implementation task before final verification");
  }
  saveRun(tasks.database, { ...run, current: next.id, reason: undefined });
  return tasks.select(next.id);
}

export function reviewRun(tasks: TaskStore, review: z.infer<typeof reviewSchema>): void {
  const run = openRun(tasks.database);
  if (!run) {
    tasks.review(review.id, review.verdict, review.reason, review.revision);
    return;
  }
  const selected = unchangedTasks(tasks, run);
  if (review.id !== run.current) {
    throw new Error("Review the current run task");
  }
  const completing = review.id === run.verification && review.verdict === "accept";
  tasks.database.transaction(() => {
    if (completing) {
      verifyCompletion(tasks, selected, run.verification);
    }
    tasks.review(review.id, review.verdict, review.reason, review.revision);
    const status = completing ? "completed" : run.status;
    const revised = review.verdict === "revise";
    saveRun(tasks.database, {
      ...run,
      status: review.verdict === "stop" ? "cancelled" : status,
      current: review.verdict === "accept" ? undefined : run.current,
      tasks: run.tasks.map((item) =>
        item.id === review.id ? savedTask(tasks, requireTask(tasks, item.id)) : item,
      ),
      reason: revised ? "Revision requested; resume explicitly to retry" : undefined,
      ...(revised ? { status: "paused" as const } : {}),
    });
  });
}

function verifyCompletion(tasks: TaskStore, selected: ProjectTask[], verification: string): void {
  if (selected.some((task) => task.id !== verification && task.status !== "accepted")) {
    throw new Error("Run still has unaccepted tasks");
  }
  if (
    tasks
      .tasks()
      .some((task) => task.id !== verification && ["running", "finished"].includes(task.status))
  ) {
    throw new Error("Review pending tasks before completing the run");
  }
  const final = requireTask(tasks, verification);
  if (!createVerificationStore(tasks.database).finalPassed(final)) {
    throw new Error(
      "Final checks are missing, failed, or stale. Revise final verification and run the checks again",
    );
  }
}

export function runSummary(tasks: TaskStore) {
  const run = readRun(tasks.database);
  if (!run) {
    return undefined;
  }
  return {
    id: run.id,
    status: run.status,
    current: run.current,
    verification: run.verification,
    tasks: run.tasks.length,
    accepted: run.tasks.filter((item) => tasks.get(item.id)?.status === "accepted").length,
    reason: run.reason,
  };
}

export function runNotice(database: ProjectDatabase): string {
  const run = readRun(database);
  if (run?.status === "completed") {
    return "Run completed. Final verification accepted. External changes remain unverified.";
  }
  return `Run ${run?.status ?? "not started"}.${run?.reason ? ` ${run.reason}.` : ""}`;
}
