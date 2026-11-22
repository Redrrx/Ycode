import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseTaskResult, taskResultSchema } from "../runtime/report.ts";
import type { WorkerReport } from "../runtime/worker.ts";
import { encode, type ProjectDatabase } from "./database.ts";
import type { DependencyGraph } from "./dependencies.ts";
import { createDependencyGraph } from "./dependencies.ts";
import { savePlan } from "./plan.ts";
import { reviewWork } from "./review.ts";
import {
  milestoneRowSchema,
  taskRowSchema,
  type parseProjectAction,
  type ProjectPlan,
  type ProjectTask,
} from "./schema.ts";
import { tables } from "./tables.ts";
import { createVerificationStore } from "./verification.ts";
interface TaskStoreData {
  readonly database: ProjectDatabase;
}

export type TaskStore = ReturnType<typeof bindTaskStore>;

export function createTaskStore(database: ProjectDatabase): TaskStore {
  return bindTaskStore({ database });
}

function bindTaskStore(self: TaskStoreData) {
  return Object.assign(self, {
    tasks: taskStoreTasks.bind(undefined, self),
    get: taskStoreGet.bind(undefined, self),
    milestones: taskStoreMilestones.bind(undefined, self),
    dependencies: taskStoreDependencies.bind(undefined, self),
    plan: taskStorePlan.bind(undefined, self),
    selected: taskStoreSelected.bind(undefined, self),
    select: taskStoreSelect.bind(undefined, self),
    start: taskStoreStart.bind(undefined, self),
    finish: taskStoreFinish.bind(undefined, self),
    review: taskStoreReview.bind(undefined, self),
    passed: taskStorePassed.bind(undefined, self),
    refresh: taskStoreRefresh.bind(undefined, self),
  });
}

export function prepareTask(
  tasks: TaskStore,
  action: NonNullable<ReturnType<typeof parseProjectAction>>,
): ProjectTask {
  if (action.action === "task") {
    if (tasks.tasks().some((task) => ["finished", "running"].includes(task.status))) {
      throw new Error("Review the pending task before starting another task");
    }
    const id = `t-${randomUUID()}`;
    tasks.plan({
      milestones: [
        {
          id: `m-${randomUUID()}`,
          objective: action.task.objective,
          tasks: [
            {
              ...action.task,
              id,
              kind: action.task.kind ?? (action.task.mode === "edit" ? "change" : "investigation"),
            },
          ],
        },
      ],
    });
    return tasks.select(id);
  }
  if (action.action === "clarify") {
    const task = tasks.get(action.id);
    if (!task || !["finished", "blocked", "interrupted"].includes(task.status)) {
      throw new Error("Clarification requires an unaccepted task result");
    }
    tasks.review(task.id, "revise", action.question, task.revision);
    return tasks.select(task.id);
  }
  if (action.action === "run") {
    const graph = tasks.dependencies();
    const members = tasks.tasks(action.id);
    const task =
      tasks.get(action.id) ??
      members.find((item) => item.status === "finished") ??
      members.find(
        (item) =>
          ["ready", "interrupted", "blocked"].includes(item.status) && !graph.blockers(item).length,
      );
    if (!task) {
      throw new Error("No ready task; inspect state for prerequisites or closed work");
    }
    return tasks.select(task.id);
  }
  throw new Error("Select one task");
}

function taskStoreTasks(self: TaskStoreData, milestone?: string): ProjectTask[] {
  const rows =
    milestone === undefined
      ? self.database.orm.select().from(tables.tasks).orderBy(tables.tasks.sequence).all()
      : self.database.orm
          .select()
          .from(tables.tasks)
          .where(eq(tables.tasks.milestone, milestone))
          .orderBy(tables.tasks.position, tables.tasks.sequence)
          .all();
  return rows.map((row) => taskRowSchema.parse(row));
}

function taskStoreGet(self: TaskStoreData, id: string): ProjectTask | undefined {
  const row = self.database.orm.select().from(tables.tasks).where(eq(tables.tasks.id, id)).get();
  return row ? taskRowSchema.parse(row) : undefined;
}

function taskStoreMilestones(self: TaskStoreData) {
  return self.database.orm
    .select()
    .from(tables.milestones)
    .orderBy(tables.milestones.sequence)
    .all()
    .map((row) => milestoneRowSchema.parse(row));
}

function taskStoreDependencies(self: TaskStoreData): DependencyGraph {
  return createDependencyGraph(taskStoreTasks(self), taskStoreMilestones(self));
}

function taskStorePlan(self: TaskStoreData, input: ProjectPlan): void {
  savePlan(bindTaskStore(self), input);
}

function taskStoreSelected(self: TaskStoreData): ProjectTask | undefined {
  const row = z
    .object({ selected: z.string().nullable() })
    .parse(self.database.orm.select().from(tables.state).where(eq(tables.state.id, 1)).get());
  return row.selected ? taskStoreGet(self, row.selected) : undefined;
}

function taskStoreSelect(self: TaskStoreData, id: string): ProjectTask {
  const task = taskStoreGet(self, id);
  if (!task) {
    throw new Error(`Unknown task: ${id}`);
  }
  self.database.orm.update(tables.state).set({ selected: id }).where(eq(tables.state.id, 1)).run();
  return task;
}

function taskStoreStart(self: TaskStoreData, task: ProjectTask): void {
  self.database.transaction(() => {
    const blockers = taskStoreDependencies(self).blockers(task);
    if (blockers.length) {
      throw new Error(`Unaccepted prerequisites: ${blockers.join(", ")}`);
    }
    if (
      taskStoreTasks(self).some((item) => item.status === "running" || item.status === "finished")
    ) {
      throw new Error("Review the pending task before starting another task");
    }
    const result = self.database.orm
      .update(tables.tasks)
      .set({ status: "running" })
      .where(
        and(
          eq(tables.tasks.id, task.id),
          eq(tables.tasks.revision, task.revision),
          inArray(tables.tasks.status, ["ready", "interrupted", "blocked"]),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new Error("Task changed or cannot be started");
    }
    taskStoreSelect(self, task.id);
    taskStoreRefresh(self, task.milestone);
    self.database.event("task_start", task.id, { revision: task.revision });
  });
}

function taskStoreFinish(self: TaskStoreData, task: ProjectTask, report: WorkerReport): boolean {
  if (report.taskId !== task.id) {
    throw new Error("Task report ID does not match execution");
  }
  let finished = false;
  if (report.status === "completed") {
    const result = taskResultSchema.parse(
      JSON.parse(parseTaskResult(report.summary, undefined, task.spec.acceptance)),
    );
    finished =
      result.outcome === "finished" && !result.criteria.some((item) => item.status === "failed");
  }
  self.database.transaction(() => {
    const result = self.database.orm
      .update(tables.tasks)
      .set({ status: finished ? "finished" : "blocked", result: encode(report) })
      .where(
        and(
          eq(tables.tasks.id, task.id),
          eq(tables.tasks.revision, task.revision),
          eq(tables.tasks.status, "running"),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new Error("Stale task report; revision or execution state changed");
    }
    taskStoreRefresh(self, task.milestone);
    self.database.event("task_result", task.id, { revision: task.revision, report });
  });
  return finished;
}

function taskStoreReview(
  self: TaskStoreData,
  id: string,
  verdict: "accept" | "revise" | "stop",
  reason: string,
  revision: number,
): void {
  self.database.transaction(() => reviewWork(bindTaskStore(self), id, verdict, reason, revision));
}

function taskStorePassed(self: TaskStoreData, task: ProjectTask): boolean {
  if (!task.result || !createVerificationStore(self.database).passed(task)) {
    return false;
  }
  const report = z.object({ summary: z.string() }).parse(JSON.parse(task.result));
  const result = taskResultSchema.parse(JSON.parse(report.summary));
  return (
    result.outcome === "finished" &&
    task.spec.acceptance.every((criterion) =>
      result.criteria.some((check) => check.criterion === criterion && check.status === "passed"),
    )
  );
}

function taskStoreRefresh(self: TaskStoreData, id: string): void {
  const tasks = taskStoreTasks(self, id);
  let status = "ready";
  if (tasks.every((task) => task.status === "accepted")) {
    status = "accepted";
  } else if (tasks.some((task) => task.status === "running")) {
    status = "running";
  } else if (tasks.some((task) => task.status === "finished")) {
    status = "review";
  } else if (tasks.some((task) => task.status === "stopped")) {
    status = "stopped";
  } else if (tasks.some((task) => ["blocked", "interrupted"].includes(task.status))) {
    status = "blocked";
  }
  self.database.orm
    .update(tables.milestones)
    .set({ status })
    .where(eq(tables.milestones.id, id))
    .run();
}
