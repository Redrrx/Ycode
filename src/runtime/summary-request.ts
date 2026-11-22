import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { ActivityLog } from "../activity/log.ts";
import type { RoleConfig } from "../config/load.ts";
import { createUsageCapture } from "../usage/provider-usage.ts";
import type { SummaryCall } from "../usage/summarization.ts";
export interface SummaryRequestOptions {
  signal: AbortSignal;
  effort: RoleConfig["summarizer"]["effort"];
  maxTokens: number;
  label: string;
}

export function summaryText(response: AssistantMessage, signal: AbortSignal): string {
  signal.throwIfAborted();
  if (response.stopReason !== "stop") {
    throw new Error(
      `Summarizer stopped (${response.stopReason}): ${response.errorMessage ?? "no complete summary"}`,
    );
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    throw new Error("Summarizer attempted to call a tool");
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("Summarizer returned an empty summary");
  }
  return text;
}

function responseStatus(response: AssistantMessage, signal: AbortSignal) {
  if (signal.aborted || response.stopReason === "aborted") {
    return "cancelled";
  }
  return response.stopReason === "stop" ? "success" : "error";
}

export async function summaryRequest(
  context: ExtensionContext,
  activity: ActivityLog,
  model: Model<Api>,
  request: Context,
  options: SummaryRequestOptions,
): Promise<{ response: AssistantMessage; call: SummaryCall }> {
  options.signal.throwIfAborted();
  const runId = randomUUID();
  const id = activity.start({
    actor: "summarizer",
    kind: "turn",
    runId,
    taskId: "summarizer",
    model: model.id,
    title: options.label,
    input: { effort: options.effort, maxTokens: options.maxTokens },
  });
  const startedAt = activity.get(id)?.startedAt ?? Date.now();
  const capture = createUsageCapture();
  let response: AssistantMessage | undefined;
  try {
    response = await context.modelRegistry
      .streamSimple(model, request, {
        signal: options.signal,
        reasoning: options.effort === "off" ? undefined : options.effort,
        maxTokens: options.maxTokens,
        cacheRetention: "none",
        sessionId: runId,
        onProviderStreamEvent(data, eventModel) {
          capture.observe(eventModel.api, data);
        },
      })
      .result();
    if (response.stopReason === "stop") {
      summaryText(response, options.signal);
    }
    const call: SummaryCall = {
      version: 1,
      id,
      startedAt,
      model: model.id,
      usage: capture.snapshot(response.usage),
    };
    activity.finish(id, {
      status: responseStatus(response, options.signal),
      usage: call.usage,
      output:
        response.stopReason === "stop"
          ? undefined
          : `Summarizer stopped (${response.stopReason}): ${response.errorMessage ?? "incomplete summary"}`,
    });
    return { response, call };
  } catch (error) {
    activity.finish(id, {
      status: options.signal.aborted ? "cancelled" : "error",
      usage: capture.snapshot(response?.usage),
      output: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
