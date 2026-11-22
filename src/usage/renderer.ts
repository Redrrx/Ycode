import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { reportSchema, USAGE_ENTRY } from "./schema.ts";
import { summaryTable } from "./table.ts";
export function renderUsage(data: unknown, theme: Theme): Component | undefined {
  const parsed = reportSchema.safeParse(data);
  if (!parsed.success) {
    return new Text(theme.fg("warning", "Unsupported or invalid Ycode usage format"), 0, 0);
  }
  const report = parsed.data;
  const summary = report.request ?? report.session;
  const time = report.elapsedSeconds === undefined ? "" : ` · ${report.elapsedSeconds.toFixed(2)}s`;
  const tools = `${summary.toolCalls} ${summary.toolCalls === 1 ? "tool" : "tools"}`;
  return {
    render(width) {
      return [
        theme.fg(
          "accent",
          truncateToWidth(
            `Usage · ${report.request ? "request" : "session"}${time} · ${tools}`,
            width,
          ),
        ),
        ...summaryTable(summary, width, true),
      ];
    },
    invalidate: () => undefined,
  };
}

export function registerUsageRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(USAGE_ENTRY, (entry, _options, theme) => renderUsage(entry.data, theme));
}
