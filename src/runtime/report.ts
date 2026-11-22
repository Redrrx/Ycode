import { z } from "zod";
import { INPUT_LIMITS, REPORT_LIMITS, WORKFLOW_LIMITS } from "../config/constants.ts";
import { parseReportJson } from "./report-json.ts";
import type { WorkerReport } from "./worker.ts";
const sourcePath = z.string().min(1).max(INPUT_LIMITS.pathChars);
const source = z.union([
  z
    .object({
      path: sourcePath,
      description: z.string().min(1).max(REPORT_LIMITS.reportItemChars),
    })
    .strict(),
  sourcePath.transform((path) => ({ path, description: "Source path" })),
]);
export const taskResultSchema = z
  .object({
    version: z.literal(2),
    outcome: z.enum(["finished", "blocked", "consult"]),
    criteria: z
      .array(
        z
          .object({
            criterion: z.string().min(1).max(INPUT_LIMITS.textChars),
            status: z.enum(["passed", "failed", "unchecked"]),
            details: z.string().min(1).max(REPORT_LIMITS.reportItemChars),
          })
          .strict(),
      )
      .max(INPUT_LIMITS.listItems)
      .default([]),
    answer: z.string().min(1),
    sources: z.array(source).default([]),
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= REPORT_LIMITS.summaryBytes,
    "Final report exceeds its UTF-8 byte limit; shorten fields while retaining the useful answer and required metadata",
  );

export const FINAL_REPORT_INSTRUCTION = `Call finish_task alone to save the answer and stop. Set outcome to finished, blocked, or consult. Put the full answer in answer, including relevant changes, check results, and limits. Do not add extra answer fields. Optional sources must be exact paths you read, or {path, description}. If acceptance criteria were supplied, report each exactly once in criteria [{criterion, status: passed/failed/unchecked, details}]. Otherwise omit criteria. Limit the full report to ${REPORT_LIMITS.summaryBytes} UTF-8 bytes. Reading source does not verify runtime behavior. Missing inventory entries and unresolved references do not prove absence. Omit unsupported optional details instead of expanding the task.`;

export function parseTaskResult(
  text: string,
  inspectedPaths?: ReadonlySet<string>,
  acceptance?: string[],
): string {
  const value = parseReportJson(text);
  const result = taskResultSchema.parse(value);
  if (
    acceptance &&
    (result.criteria.length !== acceptance.length ||
      new Set(result.criteria.map((item) => item.criterion)).size !== acceptance.length ||
      acceptance.some((criterion) => !result.criteria.some((item) => item.criterion === criterion)))
  ) {
    throw new Error("Report each acceptance criterion exactly once using its original text");
  }
  for (const source of result.sources) {
    if (inspectedPaths && !inspectedPaths.has(source.path)) {
      throw new Error(`Source path was not returned by inspection: ${source.path}`);
    }
  }
  return JSON.stringify(result);
}

const commandResultSchema = z.object({
  id: z.uuid(),
  status: z.enum(["passed", "failed", "timeout"]),
});
export function recordedCommand(details: unknown): boolean {
  return commandResultSchema.safeParse(details).success;
}

const commandRunSchema = commandResultSchema.extend({
  status: z.enum(["running", "passed", "failed", "cancelled", "timeout", "interrupted"]),
});
export function commandRunId(details: unknown): string | undefined {
  const result = commandRunSchema.safeParse(details);
  return result.success ? result.data.id : undefined;
}

const findingPathsSchema = z.object({ findings: z.array(z.object({ path: z.string() })) });
export function findingPaths(details: unknown): string[] {
  const result = findingPathsSchema.safeParse(details);
  return result.success ? result.data.findings.map((finding) => finding.path) : [];
}

const explorationSummary = z.object({
  workspaceId: z.string(),
  status: z.string(),
  stopReason: z.string(),
  findings: z.array(z.object({ path: z.string(), sourceHash: z.string(), truncated: z.boolean() })),
  coverage: z.record(z.string(), z.number()),
  warnings: z.array(z.string()),
});

export function operationSummary(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    const result = explorationSummary.safeParse(value);
    if (result.success) {
      return JSON.stringify(result.data);
    }
  } catch {
    return operationPreview(text);
  }
  return operationPreview(text);
}

function operationPreview(text: string): string {
  if (text.length <= REPORT_LIMITS.operationChars) {
    return text;
  }
  return `${text.slice(0, REPORT_LIMITS.operationChars)}\n[Operation preview shortened; final report retains the answer and limits]`;
}

export function limitReportSize(report: WorkerReport): WorkerReport {
  const output = { ...report, operations: [...report.operations] };
  while (
    Buffer.byteLength(JSON.stringify(output)) > WORKFLOW_LIMITS.reportBytes &&
    output.operations.length > 0
  ) {
    output.operations.shift();
    output.omittedOperations++;
  }
  if (Buffer.byteLength(JSON.stringify(output)) > WORKFLOW_LIMITS.reportBytes) {
    throw new Error("Worker report exceeds its byte limit; the answer was not shortened");
  }
  return output;
}
