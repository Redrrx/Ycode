import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { normalizeContext, retryAssistantCall } from "@earendil-works/pi-ai";
import { estimateTokens, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActivityLog } from "../activity/log.ts";
import { requireEffort, SUMMARIZER_LIMITS } from "../config/constants.ts";
import type { RoleConfig } from "../config/load.ts";
import { summarizerSystemPrompt } from "../prompts.ts";
import type { SummaryCall } from "../usage/summarization.ts";
import { summaryRequest, summaryText } from "./summary-request.ts";
function outputBudget(model: Model<Api>, context: Context): number {
  const estimatedInput = context.messages.reduce(
    (sum, message) => sum + estimateTokens(message),
    0,
  );
  const remaining = model.contextWindow - estimatedInput - SUMMARIZER_LIMITS.contextMargin;
  if (remaining < SUMMARIZER_LIMITS.minimumOutput) {
    throw new Error(
      `Summarizer input estimate ${estimatedInput} does not fit ${model.id} (${model.contextWindow} context). Select a larger Summarizer model; no input was removed.`,
    );
  }
  return Math.min(model.maxTokens, remaining);
}

export async function summarize(
  context: ExtensionContext,
  config: RoleConfig,
  activity: ActivityLog,
  prompt: string,
  parentSignal: AbortSignal,
  label: string,
) {
  const signal = AbortSignal.any([
    parentSignal,
    AbortSignal.timeout(config.limits.summarizerTimeoutSeconds * 1000),
  ]);
  signal.throwIfAborted();
  if (!config.summarizer.model) {
    throw new Error("Set summarizer.model in config.json and /reload to enable summaries.");
  }
  const model = context.modelRegistry.find("summarizer", config.summarizer.model);
  if (!model) {
    throw new Error(
      `Summarizer model unavailable: ${config.summarizer.model}. No model was substituted.`,
    );
  }
  const effort = requireEffort("summarizer", model, config.summarizer.effort);
  const request = normalizeContext({
    systemPrompt: summarizerSystemPrompt,
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  });
  const maxTokens = outputBudget(model, request);
  const credentials = await context.modelRegistry.getProviderAuth("summarizer");
  signal.throwIfAborted();
  if (!credentials?.auth.apiKey) {
    throw new Error("Missing summarizer credentials. Run /login summarizer.");
  }
  const calls: SummaryCall[] = [];
  const response = await retryAssistantCall(
    async () => {
      const result = await summaryRequest(context, activity, model, request, {
        signal,
        effort,
        maxTokens,
        label,
      });
      calls.push(result.call);
      return result.response;
    },
    {
      enabled: true,
      maxRetries: SUMMARIZER_LIMITS.providerRetries,
      baseDelayMs: SUMMARIZER_LIMITS.retryDelayMs,
    },
    signal,
  );
  return { text: summaryText(response, signal), usage: response.usage, calls };
}
