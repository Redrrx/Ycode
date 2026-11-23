import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { ActivityLog } from "../activity/log.ts";
import type { RoleConfig } from "../config/load.ts";
import { summarize } from "./summarizer.ts";
import { appendSummaryFiles, branchInput, compactionInput } from "./summary-input.ts";
function failed(
  activity: ActivityLog,
  context: ExtensionContext,
  error: unknown,
  signal: AbortSignal,
): { cancel: true } {
  const cancelled =
    signal.aborted ||
    (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
  const message = `Summarizer: ${error instanceof Error ? error.message : String(error)}. No fallback was used.`;
  activity.note(
    {
      actor: "summarizer",
      kind: "error",
      runId: randomUUID(),
      taskId: "summarizer",
      title: "Summary not saved",
    },
    { status: cancelled ? "cancelled" : "error", output: message },
  );
  if (context.hasUI) {
    context.ui.notify(message, cancelled ? "warning" : "error");
  }
  return { cancel: true };
}

export function registerSummarizer(
  pi: ExtensionAPI,
  activity: ActivityLog,
  configuration: () => RoleConfig,
  enabled: () => boolean,
): void {
  pi.on("session_before_compact", async (event, context) => {
    if (!enabled()) {
      return;
    }
    try {
      const input = compactionInput(event);
      const result = await summarize(
        context,
        configuration(),
        activity,
        input.prompt,
        event.signal,
        "Compaction",
      );
      event.signal.throwIfAborted();
      return {
        compaction: {
          summary: appendSummaryFiles(result.text, input),
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: result.usage,
          details: {
            readFiles: input.readFiles,
            modifiedFiles: input.modifiedFiles,
            summarizer: { version: 1, calls: result.calls },
          },
        },
      };
    } catch (error) {
      return failed(activity, context, error, event.signal);
    }
  });
  pi.on("session_before_tree", async (event, context) => {
    if (
      !enabled() ||
      !event.preparation.userWantsSummary ||
      !event.preparation.entriesToSummarize.length
    ) {
      return;
    }
    try {
      const input = branchInput(event);
      const result = await summarize(
        context,
        configuration(),
        activity,
        input.prompt,
        event.signal,
        "Branch summary",
      );
      event.signal.throwIfAborted();
      return {
        summary: {
          summary: `Summary of the previous branch:\n\n${appendSummaryFiles(result.text, input)}`,
          usage: result.usage,
          details: {
            readFiles: input.readFiles,
            modifiedFiles: input.modifiedFiles,
            summarizer: { version: 1, calls: result.calls },
          },
        },
      };
    } catch (error) {
      return failed(activity, context, error, event.signal);
    }
  });
}
