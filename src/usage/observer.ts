import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { SESSION_ENTRIES } from "../config/constants.ts";
import { measurementSchema, rememberUsage, unknownUsage } from "./measurement.ts";
import type { UsageCapture } from "./provider-usage.ts";
import { createUsageCapture } from "./provider-usage.ts";
export const observationSchema = z.object({
  version: z.literal(1),
  timestamp: z.number(),
  provider: z.string(),
  api: z.string(),
  model: z.string(),
  usage: measurementSchema,
});

export function usageKey(message: {
  timestamp: number;
  provider: string;
  api: string;
  model: string;
}): string {
  return JSON.stringify([message.timestamp, message.provider, message.api, message.model]);
}

export function registerMainUsage(pi: ExtensionAPI): void {
  let capture = createUsageCapture();
  let modelKey: string | undefined;
  pi.on("turn_start", () => {
    capture = createUsageCapture();
    modelKey = undefined;
  });
  pi.on("provider_stream_event", (event) => {
    const key = JSON.stringify([event.provider, event.api, event.model]);
    if (modelKey !== key) {
      capture = createUsageCapture();
      modelKey = key;
    }
    capture.observe(event.api, event.data);
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") {
      return;
    }
    const message = event.message;
    const matches = modelKey === JSON.stringify([message.provider, message.api, message.model]);
    const usage = matches ? capture.snapshot(message.usage) : unknownUsage();
    rememberUsage(message.usage, usage);
    pi.appendEntry(SESSION_ENTRIES.usageObservation, {
      version: 1,
      timestamp: message.timestamp,
      provider: message.provider,
      api: message.api,
      model: message.model,
      usage,
    });
  });
}

export function installWorkerUsage(session: AgentSession): void {
  const original = session.agent.streamFunction;
  if (!original) {
    return;
  }
  let capture = createUsageCapture();
  session.agent.streamFunction = (model, context, options) => {
    const current = createUsageCapture();
    capture = current;
    return original(model, context, {
      ...options,
      async onProviderStreamEvent(data, eventModel) {
        current.observe(eventModel.api, data);
        await options?.onProviderStreamEvent?.(data, eventModel);
      },
    });
  };
  session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      rememberUsage(event.message.usage, capture.snapshot(event.message.usage));
    }
  });
}

export function rememberCapturedUsage(usage: Usage | undefined, capture: UsageCapture): void {
  if (usage) {
    rememberUsage(usage, capture.snapshot(usage));
  }
}
