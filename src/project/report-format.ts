import type { z } from "zod";
import type { taskResultSchema } from "../runtime/report.ts";
type TaskResult = z.infer<typeof taskResultSchema>;

function mentioned(text: string, path: string): boolean {
  let offset = text.indexOf(path);
  while (offset >= 0) {
    const before = text[offset - 1] ?? "";
    const after = text[offset + path.length] ?? "";
    if (!/[\p{L}\p{N}_./\\-]/u.test(before) && !/[\p{L}\p{N}_./\\-]/u.test(after)) {
      return true;
    }
    offset = text.indexOf(path, offset + 1);
  }
  return false;
}

export function formatTaskResult(result: TaskResult): string {
  const lines = [result.answer];
  const sources = [...new Set(result.sources.map((source) => source.path))].filter(
    (path) => !mentioned(result.answer, path),
  );
  if (sources.length) {
    lines.push(`Sources: ${sources.map((path) => `\`${path}\``).join(", ")}`);
  }
  if (result.criteria.length) {
    lines.push(
      `Required checks:\n${result.criteria.map((item) => `- ${item.status}: ${item.criterion}: ${item.details}`).join("\n")}`,
    );
  }
  return lines.join("\n\n");
}
