import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { z } from "zod";
import { SESSION_ENTRIES } from "../config/constants.ts";
import { safeText } from "./data.ts";
import { activityDetails, activityHeader, activityStatusColor, elapsed } from "./details.ts";
import type { ActivityLog } from "./log.ts";
import { toolIssueSummary } from "./tool-status.ts";
import { ACTIVITY_ENTRY, activityEventSchema, type ActivityRecord } from "./types.ts";
interface GroupView {
  expanded: boolean;
  global: boolean;
  tools: Set<string>;
}

function objective(record: ActivityRecord): string {
  try {
    const result = z
      .object({ objective: z.string() })
      .safeParse(JSON.parse(record.input?.text ?? "null"));
    return result.success ? safeText(result.data.objective) : "";
  } catch {
    return "";
  }
}

function toolRecords(log: ActivityLog, taskSpec: ActivityRecord): ActivityRecord[] {
  return log
    .getEntries()
    .filter(
      (record) =>
        record.runId === taskSpec.runId && record.actor === "worker" && record.kind === "tool",
    );
}

function activityGroup(
  log: ActivityLog,
  initial: ActivityRecord,
  theme: Theme,
  view: GroupView,
  hint: string,
): Component {
  const rows = new Map<number, string>();
  return {
    render(width) {
      rows.clear();
      const taskSpec = log.get(initial.id) ?? initial;
      const tools = toolRecords(log, taskSpec);
      const issueText = toolIssueSummary(tools);
      const heading = `${view.expanded ? "▼" : "▶"} [WORKER] ${taskSpec.status} · ${elapsed(taskSpec)} · ${tools.length} tools${issueText}`;
      const lines = [
        truncateToWidth(
          theme.fg(activityStatusColor(taskSpec.status), `${heading} (${hint})`),
          width,
        ),
      ];
      if (!view.expanded) {
        return lines;
      }
      const goal = objective(taskSpec);
      if (goal) {
        lines.push(...new Text(goal, 0, 0).render(width));
      }
      for (const tool of tools) {
        const expanded = view.tools.has(tool.id);
        rows.set(lines.length, tool.id);
        lines.push(truncateToWidth(`  ${activityHeader(tool, expanded, theme)}`, width));
        if (expanded) {
          lines.push(...activityDetails(tool, theme, width));
        }
      }
      lines.push(
        truncateToWidth(
          theme.fg(
            "dim",
            "Click rows in fullscreen; /activity inspects full inputs, outputs and internal operations.",
          ),
          width,
        ),
      );
      return lines;
    },
    handleMouse(event) {
      if (event.type !== "click" || event.button !== "left" || event.shift) {
        return undefined;
      }
      if (event.y === 0) {
        view.expanded = !view.expanded;
        return { handled: true, render: true };
      }
      const id = rows.get(event.y);
      if (!id) {
        return undefined;
      }
      if (view.tools.has(id)) {
        view.tools.delete(id);
      } else {
        view.tools.add(id);
      }
      return { handled: true, render: true };
    },
    invalidate: () => undefined,
  };
}

export function registerActivityRenderer(pi: ExtensionAPI, log: ActivityLog): void {
  pi.registerMessageRenderer(SESSION_ENTRIES.review, (message, _options, theme) => {
    const text = z.string().safeParse(message.content);
    if (!text.success) {
      return undefined;
    }
    return new Text(
      theme.fg(text.data === "Accepted." ? "dim" : "warning", safeText(text.data)),
      0,
      0,
    );
  });
  const views = new Map<string, GroupView>();
  pi.on("session_start", () => views.clear());
  pi.registerEntryRenderer(ACTIVITY_ENTRY, (entry, options, theme) => {
    const parsed = activityEventSchema.safeParse(entry.data);
    if (!parsed.success) {
      return new Text(theme.fg("warning", "[ACTIVITY] Unreadable history record"), 0, 0);
    }
    if (parsed.data.event !== "start" || parsed.data.record.kind !== "task") {
      return undefined;
    }
    const record = parsed.data.record;
    let view = views.get(record.id);
    if (!view || view.global !== options.expanded) {
      view = { expanded: options.expanded, global: options.expanded, tools: new Set() };
      views.set(record.id, view);
    }
    return activityGroup(log, record, theme, view, options.keyHint("app.tools.expand", "details"));
  });
}
