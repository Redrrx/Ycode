import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskActivity } from "../activity/task.ts";
import { REPORT_LIMITS } from "../config/constants.ts";
import type { RoleConfig } from "../config/load.ts";
import type { ProjectDatabase } from "../project/database.ts";
import type { RecordedCheck } from "../project/execution.ts";
import { createHistoryStore } from "../project/history.ts";
import type { WriteJournal } from "../project/writes.ts";
import { taskPrompt } from "../prompts.ts";
import type { ExecutionTools } from "../tools/execution/tools.ts";
import type { TaskCompletion } from "../tools/finish.ts";
import type { Measurement } from "../usage/measurement.ts";
import type { TaskSpec } from "../workflow/protocol.ts";
import { reportVerification, validateTaskResult } from "./finalize.ts";
import { limitReportSize, operationSummary } from "./report.ts";
import { createWorker } from "./session.ts";
import { taskWorkspaceIndex } from "./workspaces.ts";
export interface ProjectExecution {
  database: ProjectDatabase;
  journal: WriteJournal;
  checkpoint: string;
  revision: number;
}

export interface WorkerReport {
  taskId: string;
  status: "completed" | "failed" | "cancelled" | "limit";
  summary: string;
  operations: { tool: string; failed: boolean; output: string }[];
  omittedOperations: number;
  commandChecks?: RecordedCheck[];
  verification?: { sourcePaths: number; commands: number };
  tokens: number | null;
  cost: number | null;
  costSource?: Measurement["costSource"];
}

function operationResults(session: AgentSession): WorkerReport["operations"] {
  const operations: WorkerReport["operations"] = [];

  for (const message of session.messages) {
    if (message.role !== "toolResult") {
      continue;
    }
    const output = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    operations.push({
      tool: message.toolName,
      failed: message.isError,
      output: operationSummary(output),
    });
  }

  return operations;
}

function reportFor(
  taskSpec: TaskSpec,
  session: AgentSession | undefined,
  status: WorkerReport["status"],
  summary: string,
  activity: TaskActivity,
  commandChecks: RecordedCheck[] = [],
): WorkerReport {
  const operations = session ? operationResults(session) : [];
  const usage = activity.getUsage();

  return limitReportSize({
    taskId: taskSpec.id,
    status,
    summary,
    ...(commandChecks.length ? { commandChecks } : {}),
    ...(session ? { verification: reportVerification(session) } : {}),
    operations: operations.slice(-REPORT_LIMITS.recentOperations),
    omittedOperations: Math.max(0, operations.length - REPORT_LIMITS.recentOperations),
    tokens: usage.totalTokens,
    cost: usage.cost,
    costSource: usage.costSource,
  });
}

interface WorkerExecutorData {
  readonly shutdown: AbortController;
  readonly pi: ExtensionAPI;
  active: Promise<WorkerReport> | undefined;
}

export type WorkerExecutor = Pick<ReturnType<typeof bindWorkerExecutor>, "dispose" | "run">;

export function createWorkerExecutor(pi: ExtensionAPI): WorkerExecutor {
  return bindWorkerExecutor({ shutdown: new AbortController(), pi, active: undefined });
}

function bindWorkerExecutor(self: WorkerExecutorData) {
  return Object.assign(self, {
    dispose: workerExecutorDispose.bind(undefined, self),
    run: workerExecutorRun.bind(undefined, self),
  });
}

async function workerExecutorDispose(self: WorkerExecutorData): Promise<void> {
  self.shutdown.abort(new Error("Session closed"));
  await self.active;
}

async function workerExecutorRun(
  self: WorkerExecutorData,
  context: ExtensionContext,
  config: RoleConfig,
  taskSpec: TaskSpec,
  activity: TaskActivity,
  project?: ProjectExecution,
): Promise<WorkerReport> {
  if (self.active) {
    throw new Error("Worker is already executing a task");
  }
  const pending = workerExecutorExecute(self, context, config, taskSpec, activity, project);
  self.active = pending;
  try {
    return await pending;
  } finally {
    self.active = undefined;
  }
}

async function workerExecutorExecute(
  self: WorkerExecutorData,
  context: ExtensionContext,
  config: RoleConfig,
  taskSpec: TaskSpec,
  activity: TaskActivity,
  project?: ProjectExecution,
): Promise<WorkerReport> {
  const deadline = AbortSignal.timeout(config.limits.workerTimeoutSeconds * 1000);
  const signals = [deadline, self.shutdown.signal];
  if (context.signal) {
    signals.push(context.signal);
  }
  const signal = AbortSignal.any(signals);
  let session: AgentSession | undefined;
  let execution: ExecutionTools | undefined;
  let completion: TaskCompletion | undefined;
  let removeListener: () => void = () => undefined;

  try {
    const created = await workerExecutorCreateSession(
      self,
      context,
      config,
      taskSpec,
      signal,
      activity,
      project,
    );
    session = created.session;
    execution = created.execution;
    completion = created.completion;
    const worker = session;
    const abort = () => worker.agent.abort();
    signal.addEventListener("abort", abort, { once: true });
    removeListener = () => signal.removeEventListener("abort", abort);
    workerExecutorObserve(worker, context, activity);
    signal.throwIfAborted();
    await worker.prompt(
      taskPrompt(taskSpec, created.workspaces) +
        (project ? `\nTask revision: ${project.revision}${project.checkpoint}` : ""),
    );
    signal.throwIfAborted();
    const checks = execution?.completedCheckRuns() ?? [];
    const passed = checks.map((item) => item.check);
    if (!completion.summary) {
      throw new Error("Worker ended without calling finish_task");
    }
    const summary = validateTaskResult(completion.summary, worker, taskSpec, passed);
    signal.throwIfAborted();
    return reportFor(taskSpec, worker, "completed", summary, activity, checks);
  } catch (error) {
    const limited = deadline.aborted;
    const status = workerExecutorFailureStatus(signal, limited);
    const reason: unknown = signal.aborted ? signal.reason : error;
    const summary = Buffer.from(reason instanceof Error ? reason.message : String(reason))
      .subarray(0, REPORT_LIMITS.summaryBytes)
      .toString("utf8");
    return reportFor(taskSpec, session, status, summary, activity);
  } finally {
    removeListener();
    try {
      await execution?.runner.dispose();
    } finally {
      session?.dispose();
      if (context.hasUI) {
        context.ui.setStatus("worker", undefined);
      }
    }
  }
}

async function workerExecutorCreateSession(
  self: WorkerExecutorData,
  context: ExtensionContext,
  config: RoleConfig,
  taskSpec: TaskSpec,
  signal: AbortSignal,
  activity: TaskActivity,
  project?: ProjectExecution,
) {
  const workspaces = await taskWorkspaceIndex(context, self.pi, project?.database);
  return createWorker(
    context,
    config,
    taskSpec,
    signal,
    activity,
    workspaces,
    project?.journal,
    project ? createHistoryStore(project.database) : undefined,
    project?.database,
    project?.revision,
  );
}

function workerExecutorFailureStatus(
  signal: AbortSignal,
  limited: boolean,
): WorkerReport["status"] {
  if (limited) {
    return "limit";
  }
  return signal.aborted ? "cancelled" : "failed";
}

function workerExecutorObserve(
  session: AgentSession,
  context: ExtensionContext,
  activity: TaskActivity,
): void {
  let calls = 0;

  session.subscribe((event) => {
    activity.observe(event);
    if (event.type === "tool_execution_start") {
      calls++;
      if (context.hasUI) {
        context.ui.setStatus(
          "worker",
          `Worker · ${session.thinkingLevel} · ${event.toolName} · call ${calls}`,
        );
      }
    }
  });
}
