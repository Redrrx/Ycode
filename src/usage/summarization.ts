import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { unknownUsage, measurementSchema } from "./measurement.ts";
import type { UsageRow } from "./schema.ts";
export const summaryCallSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  startedAt: z.number(),
  model: z.string(),
  usage: measurementSchema,
});
export type SummaryCall = z.infer<typeof summaryCallSchema>;
const detailsSchema = z.object({
  summarizer: z.object({ version: z.literal(1), calls: z.array(summaryCallSchema).min(1) }),
});

function callRows(calls: SummaryCall[], recorded: Set<string>): UsageRow[] {
  return calls
    .filter((call) => {
      if (recorded.has(call.id)) {
        return false;
      }
      recorded.add(call.id);
      return true;
    })
    .map((call) => ({
      role: "summarizer",
      label: "Summary request",
      timestamp: call.startedAt,
      usage: call.usage,
    }));
}

export function summaryUsageRows(context: ExtensionContext, recorded: Set<string>): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const entry of context.sessionManager.getBranch()) {
    if (entry.type !== "compaction" && entry.type !== "branch_summary") {
      continue;
    }
    const details = detailsSchema.safeParse(entry.details);
    if (details.success) {
      rows.push(...callRows(details.data.summarizer.calls, recorded));
    } else {
      rows.push({
        role: "summarizer",
        label: entry.type === "compaction" ? "Compaction" : "Branch summary",
        timestamp: Date.parse(entry.timestamp),
        usage: unknownUsage(),
      });
    }
  }
  return rows;
}
