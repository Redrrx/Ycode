import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { ActivityLog } from "../activity/log.ts";
import { recordReview } from "../activity/log.ts";
import { createTaskActivity } from "../activity/task.ts";
import type { WorkerEffort } from "../config/constants.ts";
import type { RoleConfig } from "../config/load.ts";
import type { TaskScheduler } from "../project/scheduler.ts";
import { openTaskScheduler } from "../project/scheduler.ts";
import { parseProjectAction, type ProjectTask } from "../project/schema.ts";
import { openRun } from "../project/run.ts";
import type { WorkspaceFacts } from "../project/workspace.ts";
import type { WorkerExecutor } from "../runtime/worker.ts";
import { createWorkerExecutor } from "../runtime/worker.ts";
import type { TaskSpec } from "./protocol.ts";
import { projectResponse, protocolError, reviewResponse } from "./protocol.ts";
interface WorkflowControllerData {
  readonly worker: WorkerExecutor;
  readonly config: RoleConfig;
  readonly activity: ActivityLog;
  project: TaskScheduler | undefined;
  projectWork: Promise<string | undefined> | undefined;
  lastAssistantId: string | undefined;
  review: { id: string; revision: number } | undefined;
  repairs: number;
  response: { timestamp: number; text: string } | undefined;
}

export type WorkflowController = Omit<
  ReturnType<typeof bindWorkflowController>,
  | "worker"
  | "config"
  | "activity"
  | "project"
  | "projectWork"
  | "lastAssistantId"
  | "review"
  | "repairs"
  | "response"
>;

export function createWorkflowController(
  pi: ExtensionAPI,
  config: RoleConfig,
  activity: ActivityLog,
): WorkflowController {
  return bindWorkflowController({
    worker: createWorkerExecutor(pi),
    config,
    activity,
    project: undefined,
    projectWork: undefined,
    lastAssistantId: undefined,
    review: undefined,
    repairs: 0,
    response: undefined,
  });
}

function bindWorkflowController(self: WorkflowControllerData) {
  return Object.assign(self, {
    openProject: workflowControllerOpenProject.bind(undefined, self),
    getRoleConfiguration: workflowControllerGetRoleConfiguration.bind(undefined, self),
    setEffort: workflowControllerSetEffort.bind(undefined, self),
    getChangeHistory: workflowControllerGetChangeHistory.bind(undefined, self),
    getProjectRevision: workflowControllerGetProjectRevision.bind(undefined, self),
    getProjectSnapshot: (workspace?: WorkspaceFacts) => self.project?.state.snapshot(workspace),
    captureResponse: workflowControllerCaptureResponse.bind(undefined, self),
    getPendingReview: workflowControllerGetPendingReview.bind(undefined, self),
    startRequest: workflowControllerStartRequest.bind(undefined, self),
    pauseRun: (reason: string) => self.project?.pause(reason),
    restore: workflowControllerRestore.bind(undefined, self),
    dispose: workflowControllerDispose.bind(undefined, self),
    handleTurn: workflowControllerHandleTurn.bind(undefined, self),
  });
}

async function workflowControllerOpenProject(
  self: WorkflowControllerData,
  context: ExtensionContext,
): Promise<void> {
  self.project = await openTaskScheduler(context);
  self.activity.history = (event, raw) => self.project?.history.record(event, raw);
}

function workflowControllerGetRoleConfiguration(self: WorkflowControllerData): RoleConfig {
  return {
    ...self.config,
    worker: {
      ...self.config.worker,
      effort: self.project?.preferences.workerEffort() ?? self.config.worker.effort,
    },
    summarizer: {
      ...self.config.summarizer,
      effort: self.project?.preferences.summarizerEffort() ?? self.config.summarizer.effort,
    },
  };
}

function workflowControllerSetEffort(
  self: WorkflowControllerData,
  role: "worker" | "summarizer",
  effort: WorkerEffort | undefined,
): void {
  if (!self.project) {
    throw new Error(`Project storage is unavailable; ${role} preference was not saved`);
  }
  if (role === "worker") {
    self.project.preferences.setWorkerEffort(effort);
  } else {
    self.project.preferences.setSummarizerEffort(effort);
  }
}

function workflowControllerGetChangeHistory(self: WorkflowControllerData) {
  return self.project?.history;
}

function workflowControllerGetProjectRevision(self: WorkflowControllerData) {
  return self.project?.state.revision();
}

function workflowControllerCaptureResponse(
  self: WorkflowControllerData,
  timestamp: number,
  text: string,
  message?: AssistantMessage,
): void {
  self.response = { timestamp, text };
  self.project?.history.recordMain(timestamp, text, message);
}

function workflowControllerGetPendingReview(self: WorkflowControllerData) {
  if (!self.project) {
    return undefined;
  }
  const run = openRun(self.project.database);
  const pending = self.project.tasks
    .tasks()
    .filter((task) => ["finished", "blocked", "interrupted"].includes(task.status));
  const task =
    pending.find((item) => item.id === run?.current) ??
    pending.find((item) => item.id === self.review?.id) ??
    pending.find((item) => item.status === "finished");
  if (!task) {
    return undefined;
  }
  return {
    id: task.id,
    revision: task.revision,
    completion: run?.verification === task.id,
    eligible: task.status === "finished" && self.project.tasks.passed(task),
  };
}

function workflowControllerTakeResponse(
  self: WorkflowControllerData,
  message: AssistantMessage,
): string {
  const captured = self.response;
  self.response = undefined;
  return captured?.timestamp === message.timestamp
    ? captured.text
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

function workflowControllerStartRequest(self: WorkflowControllerData): void {
  self.repairs = 0;
}

function workflowControllerRestore(self: WorkflowControllerData): void {
  self.project?.pause("Session navigation; resume explicitly");
  self.lastAssistantId = undefined;
  self.review = undefined;
  workflowControllerStartRequest(self);
}

async function workflowControllerDispose(self: WorkflowControllerData): Promise<void> {
  await self.worker.dispose();
  await self.projectWork?.catch(() => undefined);
  self.activity.dispose();
  self.activity.history = undefined;
  self.project?.close();
}

async function workflowControllerHandleTurn(
  self: WorkflowControllerData,
  event: TurnEndEvent,
  context: ExtensionContext,
): Promise<BoundaryResult | undefined> {
  if (
    event.outcome !== "completed" ||
    event.message.role !== "assistant" ||
    event.toolResults.length > 0 ||
    self.lastAssistantId === event.messageEntryId
  ) {
    return undefined;
  }
  self.lastAssistantId = event.messageEntryId;
  const text = workflowControllerTakeResponse(self, event.message);
  try {
    self.activity.assertReady();
    const directive = parseProjectAction(text);
    if (workflowControllerReply(self, directive)) {
      return undefined;
    }
    return await workflowControllerHandleProject(self, event, context, text);
  } catch (error) {
    const result = protocolError(event, error, ++self.repairs);
    if (!result.continue) {
      self.project?.pause("Workflow error; resume explicitly");
    }
    return result;
  }
}

function workflowControllerReply(
  self: WorkflowControllerData,
  directive: ReturnType<typeof parseProjectAction>,
): boolean {
  if (directive?.action === "project_reply" && directive.question) {
    self.project?.pause("Waiting for a user decision");
    return true;
  }
  if (directive && (directive.action !== "project_reply" || directive.review)) {
    return false;
  }
  if (workflowControllerGetPendingReview(self)) {
    throw new Error(
      "Return an explicit review with the task ID and revision; plain text does not accept work",
    );
  }
  self.project?.pause("No next action; resume explicitly");
  return true;
}

async function workflowControllerHandleProject(
  self: WorkflowControllerData,
  event: TurnEndEvent,
  context: ExtensionContext,
  text: string,
): Promise<BoundaryResult> {
  if (!self.project) {
    throw new Error("Project storage is unavailable; repository execution is disabled");
  }
  self.projectWork = self.project.handle(
    text,
    (taskSpec, task) => workflowControllerRunTask(self, context, taskSpec, task),
    context.signal,
  );
  const output = await self.projectWork;
  const directive = parseProjectAction(text);
  if (directive?.action !== "state") {
    self.review = self.project.reportedTask;
  }
  const review = workflowControllerRecordReview(self, directive, context);
  self.repairs = 0;
  const reviewed = review ? reviewResponse(event, review.verdict) : undefined;
  if (reviewed && !output) {
    return reviewed;
  }
  return projectResponse(
    { ...event, entries: reviewed?.entries ?? event.entries },
    output,
    directive?.action,
    Boolean(context.signal?.aborted),
    Boolean(self.project.reportedTask),
    self.project.state.revision(),
  );
}

function workflowControllerRecordReview(
  self: WorkflowControllerData,
  directive: ReturnType<typeof parseProjectAction>,
  context: ExtensionContext,
) {
  if (!directive || !("review" in directive) || !directive.review) {
    return;
  }
  const review = directive.review;
  recordReview(self.activity, review.id, review.verdict, context.model?.id, review);
  return review;
}

async function workflowControllerRunTask(
  self: WorkflowControllerData,
  context: ExtensionContext,
  taskSpec: TaskSpec,
  task: ProjectTask,
) {
  if (!self.project) {
    throw new Error("Project storage is unavailable");
  }
  context.signal?.throwIfAborted();
  const execution = {
    ...taskSpec,
    constraints: [...new Set([...self.project.database.constraints(), ...taskSpec.constraints])],
  };
  const config = workflowControllerGetRoleConfiguration(self);
  const activity = createTaskActivity(self.activity, execution, config, context.model?.id);
  const report = await self.worker.run(context, config, execution, activity, {
    database: self.project.database,
    journal: self.project.writes.createJournal(task.id, task.revision),
    checkpoint: self.project.checkpoint(task),
    revision: task.revision,
  });
  activity.complete(report);
  return report;
}
