import type { Usage } from "@earendil-works/pi-ai";
import { z } from "zod";
const count = z.int().nonnegative();
export const measurementSchema = z
  .object({
    version: z.literal(2),
    input: count.nullable(),
    inputTotal: count.nullable(),
    output: count.nullable(),
    cacheRead: count.nullable(),
    cacheWrite: count.nullable(),
    totalTokens: count.nullable(),
    cost: z.number().nonnegative().nullable(),
    costSource: z.enum(["reported", "estimated", "unknown"]),
  })
  .strict()
  .refine((value) => (value.cost === null) === (value.costSource === "unknown"), {
    message: "Cost and cost source disagree",
  });
export type Measurement = z.infer<typeof measurementSchema>;

export function unknownUsage(): Measurement {
  return {
    version: 2,
    input: null,
    inputTotal: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    totalTokens: null,
    cost: null,
    costSource: "unknown",
  };
}

const observed = new WeakMap<Usage, Measurement>();

export function rememberUsage(usage: Usage, measurement: Measurement): void {
  observed.set(usage, measurement);
}

export function measuredUsage(usage: Usage): Measurement {
  return observed.get(usage) ?? unknownUsage();
}

export function zeroUsage(): Measurement {
  return {
    version: 2,
    input: 0,
    inputTotal: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    costSource: "reported",
  };
}

export function sumUsage(left: Measurement, right: Measurement): Measurement {
  const result = { ...left };
  for (const field of [
    "input",
    "inputTotal",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
    "cost",
  ] as const) {
    result[field] = addKnown(left[field], right[field]);
  }
  result.costSource = combinedCostSource(result.cost, left.costSource, right.costSource);
  if (result.costSource === "unknown") {
    result.cost = null;
  }
  return result;
}

export function combinedCostSource(
  cost: number | null,
  left: Measurement["costSource"],
  right: Measurement["costSource"],
): Measurement["costSource"] {
  if (cost === null || left === "unknown" || right === "unknown") {
    return "unknown";
  }
  return left === "estimated" || right === "estimated" ? "estimated" : "reported";
}

export function addKnown(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}
