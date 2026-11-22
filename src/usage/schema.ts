import { z } from "zod";
import { activityRecordSchema } from "../activity/types.ts";
import { SESSION_ENTRIES } from "../config/constants.ts";
import { measurementSchema } from "./measurement.ts";
export const USAGE_ENTRY = SESSION_ENTRIES.usage;
const count = z.int().nonnegative();
const amount = count.nullable();
const rowSchema = z.object({
  role: z.enum(["main", "worker", "decision", "summarizer"]),
  label: z.string(),
  timestamp: z.number(),
  usage: activityRecordSchema.shape.usage,
});
const totalsSchema = z
  .object({
    requests: count,
    unmetered: count,
    input: amount,
    inputTotal: amount,
    output: amount,
    cacheRead: amount,
    cacheWrite: amount,
    tokens: amount,
    cost: z.number().nonnegative().nullable(),
    costSource: measurementSchema.shape.costSource,
  })
  .refine((value) => (value.cost === null) === (value.costSource === "unknown"), {
    message: "Cost and cost source disagree",
  });
const summarySchema = z.object({
  main: totalsSchema,
  worker: totalsSchema,
  decision: totalsSchema,
  summarizer: totalsSchema,
  toolCalls: count,
});
export const reportSchema = z
  .object({
    version: z.literal(3),
    request: summarySchema.optional(),
    session: summarySchema,
    elapsedSeconds: z.number().nonnegative().optional(),
    workerTurns: z.array(rowSchema),
    omittedTurns: count,
  })
  .strict();

export type UsageRow = z.infer<typeof rowSchema>;
export type Totals = z.infer<typeof totalsSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type Report = z.infer<typeof reportSchema>;
