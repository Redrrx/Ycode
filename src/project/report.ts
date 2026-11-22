import { z } from "zod";
import { taskResultSchema } from "../runtime/report.ts";
import { formatTaskResult } from "./report-format.ts";
import type { ProjectTask } from "./schema.ts";
const storedReport = z.object({
  status: z.enum(["completed", "failed", "cancelled", "limit"]),
  summary: z.string(),
  verification: z
    .object({
      sourcePaths: z.number().int().nonnegative(),
      commands: z.number().int().nonnegative(),
    })
    .optional(),
});

export function taskSummary(task: ProjectTask) {
  const base = { id: task.id, revision: task.revision, status: task.status };
  if (!task.result) {
    return base;
  }
  const report = storedReport.parse(JSON.parse(task.result));
  if (report.status !== "completed") {
    return { ...base, issue: report.summary };
  }
  const result = taskResultSchema.parse(JSON.parse(report.summary));
  return {
    ...base,
    outcome: result.outcome,
    verification: report.verification,
    answer: result.answer,
    criteria: result.criteria.length ? result.criteria : undefined,
    sources: result.sources.length ? result.sources : undefined,
    version: result.version,
  };
}

export function taskReport(task: ProjectTask): string {
  const result = taskSummary(task);
  const lines = [`Task ${result.id} · revision ${result.revision} · ${result.status}`];
  if ("issue" in result) {
    lines.push(result.issue);
  }
  if ("answer" in result) {
    if (result.verification) {
      const { sourcePaths, commands } = result.verification;
      lines[0] += ` · ${sourcePaths} inspected source(s) · ${commands} command run(s)`;
    }
    lines.push(
      formatTaskResult(
        taskResultSchema.parse({
          outcome: result.outcome,
          answer: result.answer,
          criteria: result.criteria,
          sources: result.sources,
          version: result.version,
        }),
      ),
    );
  }
  return lines.join("\n\n");
}
