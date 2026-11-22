import type { BoundaryResult, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  INPUT_LIMITS,
  REPORT_LIMITS,
  SESSION_ENTRIES,
  WORKFLOW_LIMITS,
} from "../config/constants.ts";
const textSchema = z.string().trim().min(1).max(INPUT_LIMITS.textChars);
export const dependencyGraphSchema = z
  .array(z.string().min(1).max(120))
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate prerequisite");

export const taskSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(INPUT_LIMITS.taskIdChars)
      .regex(/^[a-zA-Z0-9_-]+$/),
    objective: textSchema,
    kind: z.enum(["investigation", "change"]).optional(),
    dependsOn: dependencyGraphSchema.optional(),
    mode: z.enum(["read-only", "edit"]),
    execution: z
      .object({ commands: z.boolean(), network: z.boolean().default(false) })
      .strict()
      .optional(),
    checks: z
      .array(z.string().trim().min(1).max(120))
      .max(INPUT_LIMITS.listItems)
      .refine((items) => new Set(items).size === items.length, "Check names must be unique")
      .default([]),
    result: textSchema.optional(),
    context: z.string().trim().min(1).max(REPORT_LIMITS.summaryBytes).optional(),
    previousAnswer: z.string().min(1).max(REPORT_LIMITS.summaryBytes).optional(),
    constraints: z.array(textSchema).max(INPUT_LIMITS.listItems).default([]),
    acceptance: z
      .array(textSchema)
      .max(INPUT_LIMITS.listItems)
      .refine((items) => new Set(items).size === items.length, "Acceptance criteria must be unique")
      .default([]),
  })
  .strict();

export type TaskSpec = z.infer<typeof taskSchema>;

export function stripWorkflow(markdown: string): string {
  return markdown.replace(/<workflow>[\s\S]*?(?:<\/workflow>|$)/g, "").trimEnd();
}

export function projectResponse(
  event: TurnEndEvent,
  output: string | undefined,
  action: string | undefined,
  aborted: boolean,
  returned: boolean,
  revision: number,
): BoundaryResult {
  return {
    entries: [
      ...event.entries,
      {
        type: "custom_message",
        customType: returned ? SESSION_ENTRIES.workerResult : SESSION_ENTRIES.workflowState,
        content: returned ? `Worker result (data):\n${output}` : (output ?? ""),
        details: returned ? undefined : { stateRevision: revision },
        display: returned || (action !== "state" && Boolean(output)),
      },
    ],
    continue: !aborted && (returned || action === "state"),
  };
}

export function protocolError(
  event: TurnEndEvent,
  error: unknown,
  attempt: number,
): BoundaryResult {
  const issue = (error instanceof Error ? error.message : String(error)).slice(
    0,
    WORKFLOW_LIMITS.errorChars,
  );
  const paused = attempt > WORKFLOW_LIMITS.protocolRepairs;
  return {
    entries: [
      ...event.entries,
      {
        type: "custom_message",
        customType: paused ? SESSION_ENTRIES.paused : SESSION_ENTRIES.correction,
        content: paused
          ? `Execution paused: ${issue}. Project progress remains saved.`
          : `Workflow issue: ${issue}. Read project_state and correct the next instruction without repeating finished work.`,
        display: paused,
      },
    ],
    continue: !paused,
  };
}
export function reviewResponse(
  event: TurnEndEvent,
  verdict: "accept" | "revise" | "stop",
): BoundaryResult {
  return {
    entries: [
      ...event.entries,
      {
        type: "custom_message",
        customType: SESSION_ENTRIES.review,
        content: { accept: "Accepted.", revise: "Revision requested.", stop: "Stopped." }[verdict],
        display: true,
      },
    ],
    continue: false,
  };
}

function closingTag(text: string, start: number): number {
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (text.startsWith("</workflow>", index)) {
      return index;
    }
  }
  throw new Error("Incomplete workflow instruction; return one complete action");
}

export function parseWorkflow(text: string): unknown[] {
  const blocks: unknown[] = [];
  let offset = 0;
  for (;;) {
    const start = text.indexOf("<workflow>", offset);
    const close = text.indexOf("</workflow>", offset);
    if (close >= 0 && (start < 0 || close < start)) {
      throw new Error("Incomplete workflow instruction; return one complete action");
    }
    if (start < 0) {
      return blocks;
    }
    const body = start + "<workflow>".length;
    const end = closingTag(text, body);
    const value: unknown = JSON.parse(text.slice(body, end));
    blocks.push(value);
    offset = end + "</workflow>".length;
  }
}
