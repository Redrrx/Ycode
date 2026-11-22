import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { z } from "zod";
import { ACTIVITY_LIMITS } from "../config/constants.ts";
import { costText, numberText } from "../usage/table.ts";
import { changeHistoryText } from "./change-view.ts";
import { safeText } from "./data.ts";
import type { ActivityDetail, ActivityRecord } from "./types.ts";
const roleLabels = {
  main: "MAIN",
  worker: "WORKER",
  decision: "DECISION",
  summarizer: "SUMMARIZER",
  tool: "TOOL",
};
const colors: Record<ActivityRecord["status"], ThemeColor> = {
  running: "accent",
  success: "success",
  warning: "warning",
  error: "error",
  cancelled: "warning",
  interrupted: "warning",
  limit: "warning",
};
const historyResult = z.object({
  events: z.array(
    z.object({ eventId: z.number(), kind: z.string(), preview: z.string().nullable() }),
  ),
  operations: z.array(
    z.object({ operationId: z.string(), title: z.string(), preview: z.string().nullable() }),
  ),
});

export function activityStatusColor(status: ActivityRecord["status"]): ThemeColor {
  return colors[status];
}

export function elapsed(record: ActivityRecord): string {
  return record.endedAt === undefined
    ? "running"
    : `${((record.endedAt - record.startedAt) / 1000).toFixed(2)}s`;
}

export function activityHeader(record: ActivityRecord, expanded: boolean, theme: Theme): string {
  return `${expanded ? "▼" : "▶"} ${theme.fg("accent", `[${roleLabels[record.actor]}]`)} ${theme.fg(colors[record.status], record.status)} · ${safeText(record.title).replaceAll("\n", " ")} · ${elapsed(record)}`;
}

function historyOutput(record: ActivityRecord): ActivityDetail | undefined {
  if (record.title !== "work_history" || !record.output) {
    return record.output;
  }
  try {
    const value: unknown = JSON.parse(record.output.text);
    const changes = changeHistoryText(value);
    if (changes !== undefined) {
      return { ...record.output, text: changes };
    }
    const parsed = historyResult.safeParse(value);
    if (!parsed.success) {
      return record.output;
    }
    const { events, operations } = parsed.data;
    const lines = [
      `${events.length} events · ${operations.length} operations (search matches, not current source)`,
      ...events.map(
        (event) => `Event ${event.eventId} · ${event.kind}: ${event.preview ?? "No saved preview"}`,
      ),
      ...operations.map(
        (operation) =>
          `Operation ${operation.operationId}: ${operation.title}: ${operation.preview ?? "No saved output"}`,
      ),
    ];
    return { ...record.output, text: lines.join("\n") };
  } catch {
    return record.output;
  }
}

function detailSection(
  label: string,
  detail: ActivityDetail | undefined,
  theme: Theme,
  width: number,
  id: string,
): string[] {
  if (!detail) {
    return [];
  }
  const flags = [
    detail.truncated ? `truncated at ${ACTIVITY_LIMITS.detailBytes / 1024} KiB` : "",
    detail.redacted ? "recognized secrets redacted" : "",
  ].filter(Boolean);
  const suffix = flags.length ? ` (${flags.join("; ")})` : "";
  const lines = new Text(safeText(detail.text), 0, 0).render(width);
  const visible = lines.slice(0, ACTIVITY_LIMITS.detailLines);
  if (lines.length > visible.length) {
    visible.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `… ${lines.length - visible.length} more lines; /activity ${id} to inspect`,
        ),
        width,
      ),
    );
  }
  return [truncateToWidth(theme.fg("muted", `${label}${suffix}`), width), ...visible];
}

export function activityDetails(record: ActivityRecord, theme: Theme, width: number): string[] {
  const metadata = [`ID: ${record.id} · Run: ${record.runId}`];
  if (record.model) {
    metadata.push(`Model: ${record.model}`);
  }
  if (record.usage) {
    metadata.push(
      `Tokens: ${numberText(record.usage.totalTokens)} · ${costText(record.usage.cost, record.usage.costSource)}`,
    );
  }
  return [
    ...metadata.map((line) => truncateToWidth(theme.fg("dim", safeText(line)), width)),
    ...detailSection("Input", record.input, theme, width, record.id),
    ...detailSection("Output", historyOutput(record), theme, width, record.id),
  ];
}
