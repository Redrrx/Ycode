import type { Usage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { addKnown, unknownUsage, type Measurement } from "./measurement.ts";
const record = z.record(z.string(), z.unknown());
const count = z.int().nonnegative();
const money = z.number().nonnegative();
const responseEvent = z.object({
  type: z.enum(["response.completed", "response.incomplete"]),
  response: z.object({ usage: record }),
});
const usageEvent = z.object({ usage: record });

function number(value: unknown, schema: z.ZodNumber): number | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function detail(usage: Record<string, unknown>, key: string, field: string): unknown {
  const parsed = record.safeParse(usage[key]);
  return parsed.success ? parsed.data[field] : undefined;
}

function cached(usage: Record<string, unknown>): number | null {
  const values = [
    detail(usage, "prompt_tokens_details", "cached_tokens"),
    usage.prompt_cache_hit_tokens,
    usage.cached_tokens,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => number(value, count));
  const first = values[0];
  return first !== undefined && values.every((value) => value === first) ? first : null;
}

function freshInput(result: Measurement): void {
  if (result.inputTotal === null) {
    return;
  }
  const minimumCached = [result.cacheRead, result.cacheWrite].reduce<number>(
    (sum, value) => (value === null ? sum : sum + value),
    0,
  );
  if (minimumCached > result.inputTotal) {
    result.cacheRead = null;
    result.cacheWrite = null;
  } else if (result.cacheRead !== null && result.cacheWrite !== null) {
    result.input = result.inputTotal - result.cacheRead - result.cacheWrite;
  }
}

function totalTokens(usage: Record<string, unknown>, result: Measurement): number | null {
  const parts = number(addKnown(result.inputTotal, result.output), count);
  if (usage.total_tokens === undefined) {
    return parts;
  }
  const total = number(usage.total_tokens, count);
  return parts !== null && total !== parts ? null : total;
}

function readUsage(api: string, usage: Record<string, unknown>): Measurement {
  const result = unknownUsage();
  const completions = api === "openai-completions";
  const input = completions ? usage.prompt_tokens : usage.input_tokens;
  const output = completions ? usage.completion_tokens : usage.output_tokens;
  result.inputTotal = number(input, count);
  result.output = number(output, count);
  result.cacheRead = completions
    ? cached(usage)
    : number(detail(usage, "input_tokens_details", "cached_tokens"), count);
  result.cacheWrite = number(
    detail(
      usage,
      completions ? "prompt_tokens_details" : "input_tokens_details",
      "cache_write_tokens",
    ),
    count,
  );
  freshInput(result);
  result.totalTokens = totalTokens(usage, result);
  result.cost = number(usage.cost, money);
  result.costSource = result.cost === null ? "unknown" : "reported";
  return result;
}

interface UsageCaptureData {
  measurement: ReturnType<typeof unknownUsage>;
}

export type UsageCapture = Omit<ReturnType<typeof bindUsageCapture>, "measurement">;

export function createUsageCapture(): UsageCapture {
  const measurement: ReturnType<typeof unknownUsage> = unknownUsage();

  return bindUsageCapture({ measurement });
}

function bindUsageCapture(self: UsageCaptureData) {
  return Object.assign(self, {
    observe: usageCaptureObserve.bind(undefined, self),
    snapshot: usageCaptureSnapshot.bind(undefined, self),
  });
}

function usageCaptureObserve(self: UsageCaptureData, api: string, data: unknown): void {
  if (api === "openai-responses") {
    const parsed = responseEvent.safeParse(data);
    if (parsed.success) {
      self.measurement = readUsage(api, parsed.data.response.usage);
    }
    return;
  }
  if (api === "openai-completions" || api === "typesafe-system-one") {
    const parsed = usageEvent.safeParse(data);
    if (parsed.success) {
      self.measurement = readUsage(api, parsed.data.usage);
    }
  }
}

function usageCaptureSnapshot(self: UsageCaptureData, usage?: Usage): Measurement {
  const result = { ...self.measurement };
  if (!usage) {
    return result;
  }
  const cost = number(usage.cost.total, money);
  if (result.cost === null && usage.cost.totalFromProvider === true && cost !== null) {
    result.cost = cost;
    result.costSource = "reported";
  } else if (
    result.cost === null &&
    result.inputTotal !== null &&
    result.output !== null &&
    cost !== null &&
    cost > 0
  ) {
    result.cost = cost;
    result.costSource = "estimated";
  }
  return result;
}
