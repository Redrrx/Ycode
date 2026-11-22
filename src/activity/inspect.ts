import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_LIMITS } from "../config/constants.ts";
import type { HistoryStore } from "../project/history.ts";
import { showChanges } from "./changes.ts";
import { safeText } from "./data.ts";
import { exportActivity } from "./export.ts";
import type { ActivityLog } from "./log.ts";
import type { ActivityDetail, ActivityRecord } from "./types.ts";
import { showText } from "./viewer.ts";
function detailText(name: string, detail: ActivityDetail | undefined): string {
  if (!detail) {
    return `${name}: [not recorded]`;
  }
  const flags = [
    detail.truncated ? "storage-truncated" : "",
    detail.redacted ? "recognized secrets redacted" : "",
  ].filter(Boolean);
  return `${name}${flags.length ? ` (${flags.join(", ")})` : ""}:\n${detail.text}`;
}

function recordText(record: ActivityRecord): string {
  return safeText(
    [
      `${record.title}\nActor: ${record.actor} · Kind: ${record.kind} · Status: ${record.status}`,
      `ID: ${record.id}\nRun: ${record.runId}\nTask: ${record.taskId}\nParent: ${record.parentId ?? "none"}`,
      `Model: ${record.model ?? "none"}\nStarted: ${new Date(record.startedAt).toISOString()}`,
      `Usage: ${JSON.stringify(record.usage ?? null)}`,
      detailText("Input", record.input),
      detailText("Output", record.output),
    ].join("\n\n"),
  );
}

async function showRecord(context: ExtensionContext, record: ActivityRecord): Promise<void> {
  await showText(context, recordText(record));
}

async function selectRecord(
  context: ExtensionContext,
  log: ActivityLog,
  id: string,
): Promise<ActivityRecord | undefined> {
  if (id) {
    const matches = log.getEntries().filter((record) => record.id.startsWith(id));
    if (matches.length !== 1) {
      context.ui.notify("Use a unique activity ID or prefix.", "warning");
      return undefined;
    }
    return matches[0];
  }
  const records = log.getEntries().slice(-ACTIVITY_LIMITS.pickerRecords).reverse();
  if (records.length === 0) {
    context.ui.notify("No activity is recorded on this session branch.", "info");
    return undefined;
  }
  const labels = records.map((record, index) =>
    safeText(`${index + 1}. ${record.actor} · ${record.status} · ${record.title}`),
  );
  const selected = await context.ui.select(
    `Activity history · latest ${records.length} of ${log.getEntries().length}`,
    labels,
  );
  return selected === undefined ? undefined : records[labels.indexOf(selected)];
}

export function registerActivityInspector(
  pi: ExtensionAPI,
  log: ActivityLog,
  history?: () => HistoryStore | undefined,
): void {
  pi.registerCommand("activity", {
    description:
      "Inspect activity by ID, /activity changes [query], or /activity export [--details] [path] for a private HTML report without model calls",
    handler: async (args, context) => {
      if (/^export(?:\s|$)/u.test(args.trim())) {
        try {
          const path = await exportActivity(context, log, args.trim().slice("export".length));
          context.ui.notify(`Ycode HTML export: ${path}`, "info");
        } catch (error) {
          context.ui.notify(
            `Export failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }
      if (!context.hasUI) {
        return;
      }
      if (/^changes(?:\s|$)/u.test(args.trim())) {
        const store = history?.();
        if (!store) {
          context.ui.notify("Project history is unavailable.", "warning");
          return;
        }
        await showChanges(context, store, args.trim().slice("changes".length));
        return;
      }
      const record = await selectRecord(context, log, args.trim());
      if (record) {
        await showRecord(context, record);
      }
    },
  });
}
