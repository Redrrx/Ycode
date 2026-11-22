import { z } from "zod";
import { SESSION_ENTRIES } from "../config/constants.ts";
import { measurementSchema } from "../usage/measurement.ts";
export const ACTIVITY_ENTRY = SESSION_ENTRIES.activity;

const actorSchema = z.enum(["main", "worker", "decision", "summarizer", "tool"]);
const kindSchema = z.enum([
  "dispatch",
  "task",
  "turn",
  "tool",
  "decision",
  "progress",
  "review",
  "error",
]);
const terminalSchema = z.enum(["success", "warning", "error", "cancelled", "interrupted", "limit"]);
const detailSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
  redacted: z.boolean(),
});

export const activityRecordSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    taskId: z.string(),
    parentId: z.string().optional(),
    sourceId: z.string().optional(),
    actor: actorSchema,
    kind: kindSchema,
    model: z.string().optional(),
    title: z.string(),
    status: z.enum(["running", ...terminalSchema.options]),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    input: detailSchema.optional(),
    output: detailSchema.optional(),
    usage: measurementSchema.optional(),
  })
  .strict();

const finishSchema = z
  .object({
    id: z.string(),
    status: terminalSchema,
    endedAt: z.number(),
    title: z.string().optional(),
    output: detailSchema.optional(),
    usage: measurementSchema.optional(),
  })
  .strict();

export const activityEventSchema = z.discriminatedUnion("event", [
  z
    .object({ version: z.literal(2), event: z.literal("start"), record: activityRecordSchema })
    .strict(),
  z.object({ version: z.literal(2), event: z.literal("finish"), update: finishSchema }).strict(),
]);

export type ActivityRecord = z.infer<typeof activityRecordSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type ActivityDetail = z.infer<typeof detailSchema>;
export type ActivityUsage = z.infer<typeof measurementSchema>;
export type ActivityStatus = z.infer<typeof terminalSchema>;

export interface ActivityStart {
  runId: string;
  taskId: string;
  parentId?: string;
  sourceId?: string;
  actor: ActivityRecord["actor"];
  kind: ActivityRecord["kind"];
  model?: string;
  title: string;
  input?: unknown;
}

export interface ActivityFinish {
  status: ActivityStatus;
  title?: string;
  output?: unknown;
  usage?: ActivityUsage;
}
