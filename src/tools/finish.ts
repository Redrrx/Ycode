import { defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { INPUT_LIMITS, REPORT_LIMITS, TOOL_NAMES } from "../config/constants.ts";
import { validateTaskResult } from "../runtime/finalize.ts";
import type { TaskSpec } from "../workflow/protocol.ts";
const path = Type.String({ minLength: 1, maxLength: INPUT_LIMITS.pathChars });
const parameters = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal("finished"),
      Type.Literal("blocked"),
      Type.Literal("consult"),
    ]),
    answer: Type.String({
      minLength: 1,
      description:
        "The answer for the user, with relevant changes, check results, and limits. Stay within the request. Reading source is not a runtime check. Missing inventory entries do not prove absence.",
    }),
    sources: Type.Optional(
      Type.Array(
        Type.Union([
          path,
          Type.Object(
            {
              path,
              description: Type.String({ minLength: 1, maxLength: REPORT_LIMITS.reportItemChars }),
            },
            { additionalProperties: false },
          ),
        ]),
      ),
    ),
    criteria: Type.Optional(
      Type.Array(
        Type.Object(
          {
            criterion: Type.String({ minLength: 1, maxLength: INPUT_LIMITS.textChars }),
            status: Type.Union([
              Type.Literal("passed"),
              Type.Literal("failed"),
              Type.Literal("unchecked"),
            ]),
            details: Type.String({ minLength: 1, maxLength: REPORT_LIMITS.reportItemChars }),
          },
          { additionalProperties: false },
        ),
        { maxItems: INPUT_LIMITS.listItems },
      ),
    ),
  },
  { additionalProperties: false },
);

interface TaskCompletionData {
  summary: string | undefined;
  session: AgentSession | undefined;
  readonly taskSpec: TaskSpec;
  readonly checks: () => string[];
}

export type TaskCompletion = Omit<ReturnType<typeof bindTaskCompletion>, "checks">;

export function createTaskCompletion(taskSpec: TaskSpec, checks: () => string[]): TaskCompletion {
  return bindTaskCompletion({
    summary: undefined,
    session: undefined,
    taskSpec,
    checks,
  });
}

function bindTaskCompletion(self: TaskCompletionData) {
  return Object.assign(self, {
    tool: taskCompletionTool.bind(undefined, self),
    install: taskCompletionInstall.bind(undefined, self),
  });
}

function taskCompletionTool(self: TaskCompletionData) {
  return defineTool({
    name: TOOL_NAMES.finish,
    label: "Finish Task",
    description:
      "Save the answer and stop Worker. Call alone when the task is finished, blocked, or needs a decision. Do not expand the task for optional details. Sources must be paths you read. Named checks require current passes. If the report is invalid, correct it in the same task.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters,
    executionMode: "sequential",
    execute: async (_id, report, signal) => {
      signal?.throwIfAborted();
      if (!self.session || self.summary) {
        throw new Error("Cannot finish: Worker session is missing or the task is already finished");
      }
      self.summary = validateTaskResult(
        JSON.stringify({ ...report, version: 2 }),
        self.session,
        self.taskSpec,
        self.checks(),
      );
      return {
        content: [{ type: "text" as const, text: "Result saved. Worker finished." }],
        details: { summary: self.summary },
        terminate: true,
      };
    },
  });
}

function taskCompletionInstall(self: TaskCompletionData, session: AgentSession): void {
  self.session = session;
  const previous = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    const prior = await previous?.(context, signal);
    if (prior?.block) {
      return prior;
    }
    if (self.summary) {
      return {
        block: true,
        reason: "Task is finished. No further execution is allowed",
        terminate: true,
      };
    }
    const calls = context.assistantMessage.content.filter((block) => block.type === "toolCall");
    if (calls.length > 1 && calls.some((call) => call.name === TOOL_NAMES.finish)) {
      return {
        block: true,
        reason: "Call finish_task alone. No actions in this batch were run.",
      };
    }
    return prior;
  };
}
