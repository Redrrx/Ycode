import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { RoleConfig } from "../config/load.ts";
import type { ObserveDecision } from "../decision/request.ts";
import type { ObserveRepositoryOperation } from "../repository/commands.ts";
import type { ContextProjectionUsage } from "../runtime/context.ts";
import type { WorkerReport } from "../runtime/worker.ts";
import { sumUsage, unknownUsage, zeroUsage } from "../usage/measurement.ts";
import { costText, numberText } from "../usage/table.ts";
import type { TaskSpec } from "../workflow/protocol.ts";
import { activityUsage, extractToolOutput, formatDecisionTitle, formatToolTitle } from "./data.ts";
import type { ActivityLog } from "./log.ts";
import type { ActivityStatus } from "./types.ts";
const taskStatuses: Record<WorkerReport["status"], ActivityStatus> = {
  completed: "success",
  failed: "error",
  cancelled: "cancelled",
  limit: "limit",
};

interface TaskActivityData {
  readonly runId: ReturnType<typeof randomUUID>;
  readonly log: ActivityLog;
  readonly taskSpec: TaskSpec;
  readonly config: RoleConfig;
  readonly rootId: string;
  readonly tools: Map<string, string>;
  turnId: string | undefined;
  turn: number;
  decisionCalls: number;
}

export type TaskActivity = Omit<
  ReturnType<typeof bindTaskActivity>,
  "log" | "taskSpec" | "config" | "rootId" | "tools" | "turnId" | "turn" | "decisionCalls"
>;

export function createTaskActivity(
  log: ActivityLog,
  taskSpec: TaskSpec,
  config: RoleConfig,
  mainModel?: string,
): TaskActivity {
  const runId: ReturnType<typeof randomUUID> = randomUUID();

  log.note(
    {
      runId,
      taskId: taskSpec.id,
      actor: "main",
      kind: "dispatch",
      model: mainModel,
      title: `Dispatch ${taskSpec.id} · ${taskSpec.mode}`,
      input: taskSpec,
    },
    { status: "success" },
  );
  const rootId: string = log.start({
    runId,
    taskId: taskSpec.id,
    actor: "worker",
    kind: "task",
    model: config.worker.model,
    title: `${taskSpec.id} · ${taskSpec.mode}`,
    input: taskSpec,
  });

  return bindTaskActivity({
    runId,
    log,
    taskSpec,
    config,
    rootId,
    tools: new Map<string, string>(),
    turnId: undefined,
    turn: 0,
    decisionCalls: 0,
  });
}

function bindTaskActivity(self: TaskActivityData) {
  return Object.assign(self, {
    observe: taskActivityObserve.bind(undefined, self),
    contextProjection: taskActivityContextProjection.bind(undefined, self),
    operationId: taskActivityOperationId.bind(undefined, self),
    progress: taskActivityProgress.bind(undefined, self),
    repositoryOperations: taskActivityRepositoryOperations.bind(undefined, self),
    decisions: taskActivityDecisions.bind(undefined, self),
    getUsage: taskActivityGetUsage.bind(undefined, self),
    complete: taskActivityComplete.bind(undefined, self),
  });
}

function taskActivityObserve(self: TaskActivityData, event: AgentSessionEvent): void {
  if (event.type === "turn_start") {
    taskActivityStartTurn(self);
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    taskActivityFinishTurn(self, event.message);
  }
  if (event.type === "tool_execution_start") {
    const id = self.log.start({
      ...taskActivityChild(self, "worker", "tool"),
      sourceId: event.toolCallId,
      title: formatToolTitle(event.toolName, event.args),
      input: event.args,
    });
    self.tools.set(event.toolCallId, id);
  }
  if (event.type === "tool_execution_end") {
    const id = self.tools.get(event.toolCallId);
    if (id) {
      self.log.finish(id, {
        status: event.isError ? "error" : "success",
        output: extractToolOutput(event.result),
      });
    }
  }
}

function taskActivityContextProjection(
  self: TaskActivityData,
  usage: ContextProjectionUsage,
): void {
  self.log.note(
    {
      ...taskActivityChild(self, "tool", "progress"),
      parentId: self.turnId ?? self.rootId,
      title: `Tool context: ${usage.originalToolCharacters} → ${usage.projectedToolCharacters} characters`,
    },
    { status: "success", output: usage },
  );
}

function taskActivityOperationId(self: TaskActivityData, toolCallId: string): string | undefined {
  return self.tools.get(toolCallId);
}

function taskActivityProgress(self: TaskActivityData, toolCallId: string, message: string): void {
  self.log.note(
    {
      ...taskActivityChild(self, "tool", "progress"),
      model: undefined,
      parentId: self.tools.get(toolCallId) ?? self.rootId,
      title: `Progress: ${message}`,
    },
    { status: "success" },
  );
}

function taskActivityRepositoryOperations(
  self: TaskActivityData,
  toolCallId: string,
): ObserveRepositoryOperation {
  return (operation) => {
    const id = self.log.start({
      ...taskActivityChild(self, "tool", "tool"),
      parentId: self.tools.get(toolCallId) ?? self.rootId,
      model: undefined,
      title: operation.title,
      input: operation.input,
    });
    return {
      complete: (output) => self.log.finish(id, { status: "success", output }),
      fail: (error) =>
        self.log.finish(id, {
          status: "error",
          output: error instanceof Error ? error.message : String(error),
        }),
    };
  };
}

function taskActivityDecisions(self: TaskActivityData, toolCallId: string): ObserveDecision {
  return (stage, request, candidates) => {
    self.decisionCalls++;
    const id = self.log.start({
      ...taskActivityChild(self, "decision", "decision"),
      parentId: self.tools.get(toolCallId) ?? self.rootId,
      model: self.config.decision.model,
      title: `${stage} · ${candidates.length} typed questions/candidates`,
      input: request,
    });
    return {
      complete: (result) =>
        self.log.finish(id, {
          status: "success",
          title: formatDecisionTitle(stage, result, candidates),
          output: result,
          usage: activityUsage(result.usage),
        }),
      fail: (error, result, cancelled) =>
        self.log.finish(id, {
          status: cancelled ? "cancelled" : "error",
          output: {
            error: error instanceof Error ? error.message : String(error),
            response: result,
          },
          usage: activityUsage(result?.usage),
        }),
    };
  };
}

function taskActivityGetUsage(self: TaskActivityData) {
  return self.log
    .getEntries()
    .filter(
      (record) =>
        record.runId === self.runId && (record.kind === "turn" || record.kind === "decision"),
    )
    .reduce((total, record) => sumUsage(total, record.usage ?? unknownUsage()), zeroUsage());
}

function taskActivityComplete(self: TaskActivityData, report: WorkerReport): void {
  self.log.finish(self.rootId, {
    status: taskStatuses[report.status],
    title: `${self.taskSpec.id} · ${self.decisionCalls} decision calls · Worker + decision: ${numberText(report.tokens)} tokens · ${costText(report.cost, report.costSource ?? "unknown")}`,
    output: report,
  });
  self.log.closeRun(self.runId, "interrupted");
}

function taskActivityChild(
  self: TaskActivityData,
  actor: "worker" | "decision" | "tool",
  kind: "tool" | "turn" | "decision" | "progress",
) {
  return {
    actor,
    kind,
    runId: self.runId,
    taskId: self.taskSpec.id,
    parentId: self.rootId,
    model: self.config.worker.model,
  };
}

function taskActivityStartTurn(self: TaskActivityData): void {
  self.turn++;
  self.turnId = self.log.start({
    ...taskActivityChild(self, "worker", "turn"),
    title: `Generate turn ${self.turn}`,
  });
}

function taskActivityFinishTurn(self: TaskActivityData, message: AssistantMessage): void {
  if (!self.turnId) {
    return;
  }
  let status: ActivityStatus = "success";
  if (message.stopReason === "error") {
    status = "error";
  }
  if (message.stopReason === "aborted") {
    status = "cancelled";
  }
  self.log.finish(self.turnId, {
    status,
    output: {
      text: message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      tools: message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => block.name),
      stopReason: message.stopReason,
      error: message.errorMessage,
    },
    usage: activityUsage(message.usage),
  });
}
