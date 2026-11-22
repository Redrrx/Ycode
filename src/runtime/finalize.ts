import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { TOOL_NAMES } from "../config/constants.ts";
import type { TaskSpec } from "../workflow/protocol.ts";
import { parseReportJson } from "./report-json.ts";
import {
  commandRunId,
  taskResultSchema,
  findingPaths,
  parseTaskResult,
  recordedCommand,
} from "./report.ts";
export function reportVerification(session: AgentSession) {
  const results = session.messages.filter((message) => message.role === "toolResult");
  return {
    sourcePaths: new Set(results.flatMap((message) => findingPaths(message.details))).size,
    commands: new Set(
      results
        .filter((message) => message.toolName === TOOL_NAMES.command)
        .map((message) => commandRunId(message.details))
        .filter((id) => id !== undefined),
    ).size,
  };
}

export function validateTaskResult(
  text: string,
  session: AgentSession,
  taskSpec: TaskSpec,
  checks: string[],
): string {
  const report = taskResultSchema.parse(parseReportJson(text));
  const completed = session.messages.some(
    (message) =>
      message.role === "toolResult" &&
      message.toolName !== TOOL_NAMES.finish &&
      (!message.isError ||
        (message.toolName === TOOL_NAMES.command && recordedCommand(message.details))),
  );
  if (!completed) {
    if (
      report.outcome === "finished" ||
      report.sources.length ||
      report.criteria.some((item) => item.status === "passed")
    ) {
      throw new Error(
        "Worker performed no successful operation; only an unchecked blocker or consultation can be reported",
      );
    }
  }
  const paths = new Set(
    session.messages.flatMap((message) =>
      message.role === "toolResult" ? findingPaths(message.details) : [],
    ),
  );
  const summary = parseTaskResult(JSON.stringify(report), paths, taskSpec.acceptance);
  const missing = taskSpec.checks.filter((name) => !checks.includes(name));
  if (report.outcome === "finished" && missing.length) {
    throw new Error(
      `Requested checks did not pass on the current task state: ${missing.join(", ")}`,
    );
  }
  return summary;
}
