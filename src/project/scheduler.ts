import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { and, eq } from "drizzle-orm";
import type { WorkerReport } from "../runtime/worker.ts";
import type { TaskSpec } from "../workflow/protocol.ts";
import { openProjectDatabase, type ProjectDatabase } from "./database.ts";
import { createHistoryStore, type HistoryStore } from "./history.ts";
import { createExecutionLease, type ExecutionLease } from "./lease.ts";
import { createPreferenceStore, type PreferenceStore } from "./preferences.ts";
import { taskReport, taskSummary } from "./report.ts";
import {
  changeRunStatus,
  nextRunTask,
  openRun,
  readRun,
  reviewRun,
  runNotice,
  startRun,
} from "./run.ts";
import { parseProjectAction, serializeCheck, type ProjectTask } from "./schema.ts";
import { createProjectState, type ProjectState } from "./state.ts";
import { tables } from "./tables.ts";
import { createTaskStore, prepareTask, type TaskStore } from "./tasks.ts";
import { createVerificationStore } from "./verification.ts";
import { createWriteStore, type WriteStore } from "./writes.ts";
type Execute = (taskSpec: TaskSpec, task: ProjectTask) => Promise<WorkerReport>;
type Action = NonNullable<ReturnType<typeof parseProjectAction>>;

interface TaskSchedulerData {
  readonly tasks: TaskStore;
  readonly history: HistoryStore;
  readonly writes: WriteStore;
  readonly preferences: PreferenceStore;
  readonly state: ProjectState;
  readonly lease: ExecutionLease;
  readonly database: ProjectDatabase;
  busy: boolean;
  ownsLease: boolean;
  reportedTask: { id: string; revision: number } | undefined;
}
export type TaskScheduler = Omit<
  ReturnType<typeof bindTaskScheduler>,
  "lease" | "busy" | "ownsLease"
>;

export function createTaskScheduler(database: ProjectDatabase): TaskScheduler {
  const tasks = createTaskStore(database);
  return bindTaskScheduler({
    tasks,
    database,
    history: createHistoryStore(database),
    writes: createWriteStore(database),
    preferences: createPreferenceStore(database),
    state: createProjectState(tasks),
    lease: createExecutionLease(database),
    busy: false,
    ownsLease: false,
    reportedTask: undefined,
  });
}

function bindTaskScheduler(self: TaskSchedulerData) {
  return Object.assign(self, {
    handle: taskSchedulerHandle.bind(undefined, self),
    pause: taskSchedulerPause.bind(undefined, self),
    recover: taskSchedulerRecover.bind(undefined, self),
    checkpoint: taskSchedulerCheckpoint.bind(undefined, self),
    close: taskSchedulerClose.bind(undefined, self),
  });
}

export async function openTaskScheduler(context: ExtensionContext): Promise<TaskScheduler> {
  const scheduler = createTaskScheduler(await openProjectDatabase(context.cwd));
  try {
    scheduler.database.session = context.sessionManager.getSessionId();
    scheduler.recover();
    return scheduler;
  } catch (error) {
    scheduler.close();
    throw error;
  }
}

function taskSchedulerRecover(self: TaskSchedulerData): void {
  self.lease.acquire();
  try {
    if (readRun(self.database)?.status === "running") {
      changeRunStatus(self.database, "paused", "Session restarted; resume explicitly");
    }
  } finally {
    self.lease.release();
  }
}

function taskSchedulerPause(self: TaskSchedulerData, reason: string): void {
  if (self.ownsLease && readRun(self.database)?.status === "running") {
    changeRunStatus(self.database, "paused", reason);
  }
  if (self.ownsLease && !self.busy) {
    self.lease.release();
    self.ownsLease = false;
  }
}

async function taskSchedulerHandle(
  self: TaskSchedulerData,
  text: string,
  execute: Execute,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (self.busy) {
    throw new Error("A task is already executing");
  }
  const action = parseProjectAction(text);
  if (!action) {
    return undefined;
  }
  self.reportedTask = undefined;
  if (action.action === "state") {
    return JSON.stringify(
      self.state.inspect({ id: action.id, offset: action.offset, revision: action.revision }),
    );
  }
  signal?.throwIfAborted();
  self.lease.acquire();
  self.ownsLease = true;
  self.busy = true;
  try {
    const conflicts = await self.writes.reconcile(true);
    signal?.throwIfAborted();
    const output = await taskSchedulerAction(self, action, execute, conflicts);
    if (signal?.aborted) {
      taskSchedulerPause(self, "Execution cancelled; resume explicitly");
    }
    return output;
  } catch (error) {
    taskSchedulerPause(self, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    self.busy = false;
    if (readRun(self.database)?.status !== "running") {
      self.lease.release();
      self.ownsLease = false;
    }
  }
}

async function taskSchedulerAction(
  self: TaskSchedulerData,
  action: Action,
  execute: Execute,
  conflicts: string[],
): Promise<string | undefined> {
  const hadRun = Boolean(openRun(self.database));
  taskSchedulerUpdate(self, action, conflicts);
  if (["start_run", "resume_run", "project_reply"].includes(action.action)) {
    const task = nextRunTask(self.tasks);
    if (task) {
      return taskSchedulerRunTask(self, task, execute, conflicts);
    }
    return action.action === "project_reply" && !hadRun ? undefined : runNotice(self.database);
  }
  if (action.action === "pause_run" || action.action === "cancel_run") {
    return runNotice(self.database);
  }
  if (action.action === "plan") {
    self.tasks.plan(action.plan);
    return "Plan saved.";
  }
  return taskSchedulerRunTask(self, prepareTask(self.tasks, action), execute, conflicts);
}

function taskSchedulerUpdate(self: TaskSchedulerData, action: Action, conflicts: string[]): void {
  if (
    openRun(self.database) &&
    !["project_reply", "resume_run", "pause_run", "cancel_run"].includes(action.action)
  ) {
    throw new Error("Review, resume, or cancel the current run before starting other work");
  }
  if (action.action === "project_reply" && !action.review) {
    if (!action.question) {
      throw new Error("Return a review or a user question");
    }
    changeRunStatus(self.database, "paused", "Waiting for a user decision");
    return;
  }
  if ("review" in action && action.review) {
    if (action.review.verdict === "accept" && conflicts.length) {
      throw new Error("Resolve interrupted write conflicts before accepting work");
    }
    reviewRun(self.tasks, action.review);
  }
  if (["start_run", "resume_run", "pause_run", "cancel_run"].includes(action.action)) {
    taskSchedulerRunAction(self, action);
  }
}

function taskSchedulerRunAction(self: TaskSchedulerData, action: Action): void {
  if (action.action === "start_run") {
    if (action.revision !== self.state.revision()) {
      throw new Error("Project state changed; inspect the plan before starting a run");
    }
    startRun(self.tasks, action.tasks, action.verification);
    return;
  }
  const run = openRun(self.database);
  if (!run) {
    throw new Error("No running or paused plan");
  }
  if (action.action === "resume_run") {
    if (run.status !== "paused") {
      throw new Error("Run is already running");
    }
    changeRunStatus(self.database, "running");
  } else if (action.action === "cancel_run") {
    changeRunStatus(self.database, "cancelled", "Cancelled by request");
  } else {
    changeRunStatus(self.database, "paused", "Paused by request");
  }
}

async function taskSchedulerRunTask(
  self: TaskSchedulerData,
  task: ProjectTask,
  execute: Execute,
  conflicts: string[],
): Promise<string> {
  if (task.status !== "finished") {
    if (task.spec.mode === "edit" && conflicts.length) {
      throw new Error(
        `Resolve interrupted write conflicts before editing: ${conflicts.join(", ")}`,
      );
    }
    self.tasks.start(task);
    try {
      self.tasks.finish(task, await execute(task.spec, task));
    } catch (error) {
      taskSchedulerInterrupt(self, task, error);
      throw error;
    }
  }
  const completed = self.tasks.select(task.id);
  if (completed.status !== "finished") {
    taskSchedulerPause(
      self,
      `Task ${task.id} is ${completed.status}; review the result before retrying`,
    );
  }
  self.reportedTask = { id: completed.id, revision: completed.revision };
  return taskReport(completed);
}

function taskSchedulerInterrupt(self: TaskSchedulerData, task: ProjectTask, error: unknown): void {
  self.database.transaction(() => {
    self.database.orm
      .update(tables.tasks)
      .set({ status: "interrupted" })
      .where(
        and(
          eq(tables.tasks.id, task.id),
          eq(tables.tasks.revision, task.revision),
          eq(tables.tasks.status, "running"),
        ),
      )
      .run();
    self.tasks.refresh(task.milestone);
    self.database.event("task_interrupted", task.id, {
      revision: task.revision,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

function taskSchedulerCheckpoint(self: TaskSchedulerData, task: ProjectTask): string {
  const prerequisites = self.tasks.dependencies().prerequisites(task).map(taskSummary);
  const checks = createVerificationStore(self.database)
    .definitions()
    .filter((check) => task.spec.checks.includes(check.name));
  const details = {
    prerequisites: prerequisites.length ? prerequisites : undefined,
    checks: checks.length ? checks.map(serializeCheck) : undefined,
  };
  const context = prerequisites.length || checks.length ? `\n${JSON.stringify(details)}` : "";
  return `${context}${self.history.checkpoint(task.id)}`;
}

function taskSchedulerClose(self: TaskSchedulerData): void {
  taskSchedulerPause(self, "Session closed; resume explicitly");
  self.database.close();
}
