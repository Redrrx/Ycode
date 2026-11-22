import { z } from "zod";
import type { ActivityRecord } from "./types.ts";
const resultSchema = z.object({
  status: z.string().optional(),
  stopReason: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});
type Issue = "failed" | "stopped" | "partial" | "warning";

function resultIssue(record: ActivityRecord): Issue | undefined {
  try {
    const result = resultSchema.safeParse(JSON.parse(record.output?.text ?? "null"));
    if (!result.success) {
      return undefined;
    }
    if (result.data.status === "partial" && result.data.stopReason !== "structure_only") {
      return "partial";
    }
    return result.data.warnings?.length ? "warning" : undefined;
  } catch {
    return undefined;
  }
}

function toolIssue(record: ActivityRecord): Issue | undefined {
  if (record.status === "error") {
    return "failed";
  }
  if (["cancelled", "interrupted", "limit"].includes(record.status)) {
    return "stopped";
  }
  if (record.status === "running") {
    return undefined;
  }
  return resultIssue(record) ?? (record.status === "warning" ? "warning" : undefined);
}

export function toolIssueSummary(tools: ActivityRecord[]): string {
  const counts = { failed: 0, stopped: 0, partial: 0, warning: 0 };
  for (const tool of tools) {
    const issue = toolIssue(tool);
    if (issue) {
      counts[issue]++;
    }
  }
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([issue, count]) => ` · ${count} ${issue === "warning" && count > 1 ? "warnings" : issue}`)
    .join("");
}
