import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActivityLog } from "../activity/log.ts";
import type { ActivityUsage } from "../activity/types.ts";
import { SESSION_ENTRIES, USAGE_LIMITS } from "../config/constants.ts";
import { addKnown, combinedCostSource, unknownUsage, type Measurement } from "./measurement.ts";
import { observationSchema, usageKey } from "./observer.ts";
import type { Report, Summary, Totals, UsageRow } from "./schema.ts";
import { summaryUsageRows } from "./summarization.ts";
export function emptyTotals(): Totals {
  return {
    requests: 0,
    unmetered: 0,
    input: 0,
    inputTotal: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    cost: 0,
    costSource: "reported",
  };
}

export function add(totals: Totals, usage: ActivityUsage | undefined): void {
  totals.requests++;
  const value = usage ?? unknownUsage();
  if (
    [
      value.inputTotal,
      value.output,
      value.cacheRead,
      value.cacheWrite,
      value.totalTokens,
      value.cost,
    ].every((field) => field === null)
  ) {
    totals.unmetered++;
  }
  for (const field of [
    "input",
    "inputTotal",
    "output",
    "cacheRead",
    "cacheWrite",
    "cost",
  ] as const) {
    totals[field] = addKnown(totals[field], value[field]);
  }
  totals.tokens = addKnown(totals.tokens, value.totalTokens);
  totals.costSource = combinedCostSource(totals.cost, totals.costSource, value.costSource);
}

export function mergeTotals(total: Totals, added: Totals): void {
  total.requests += added.requests;
  total.unmetered += added.unmetered;
  for (const field of [
    "input",
    "inputTotal",
    "output",
    "cacheRead",
    "cacheWrite",
    "tokens",
    "cost",
  ] as const) {
    total[field] = addKnown(total[field], added[field]);
  }
  total.costSource = combinedCostSource(total.cost, total.costSource, added.costSource);
}

function observations(context: ExtensionContext): Map<string, Measurement> {
  const values = new Map<string, Measurement>();
  const messages = new Set<string>();
  for (const entry of context.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const key = usageKey(entry.message);
      if (messages.has(key)) {
        values.set(key, unknownUsage());
      }
      messages.add(key);
    }
    if (entry.type !== "custom" || entry.customType !== SESSION_ENTRIES.usageObservation) {
      continue;
    }
    const parsed = observationSchema.safeParse(entry.data);
    if (parsed.success) {
      const key = usageKey(parsed.data);
      const previous = values.get(key);
      values.set(
        key,
        previous && JSON.stringify(previous) !== JSON.stringify(parsed.data.usage)
          ? unknownUsage()
          : parsed.data.usage,
      );
    }
  }
  return values;
}

function usageRows(context: ExtensionContext, log: ActivityLog): UsageRow[] {
  const rows: UsageRow[] = [];
  const measured = observations(context);
  for (const entry of context.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      rows.push({
        role: "main",
        label: "Main turn",
        timestamp: entry.message.timestamp,
        usage: measured.get(usageKey(entry.message)) ?? unknownUsage(),
      });
    }
  }
  for (const record of log.getEntries()) {
    if (record.actor === "worker" && record.kind === "turn") {
      rows.push({
        role: "worker",
        label: `${record.taskId} · ${record.title}`,
        timestamp: record.startedAt,
        usage: record.usage,
      });
    }
    if (
      (record.actor === "decision" && record.kind === "decision") ||
      (record.actor === "summarizer" && record.kind === "turn")
    ) {
      rows.push({
        role: record.actor,
        label: record.title,
        timestamp: record.startedAt,
        usage: record.usage,
      });
    }
  }
  const recorded = new Set(
    log
      .getEntries()
      .filter((record) => record.actor === "summarizer" && record.kind === "turn")
      .map((record) => record.id),
  );
  return [...rows, ...summaryUsageRows(context, recorded)];
}

function summarize(rows: UsageRow[], log: ActivityLog, since: number): Summary {
  const summary: Summary = {
    main: emptyTotals(),
    worker: emptyTotals(),
    decision: emptyTotals(),
    summarizer: emptyTotals(),
    toolCalls: 0,
  };
  for (const row of rows) {
    if (row.timestamp >= since) {
      add(summary[row.role], row.usage);
    }
  }
  summary.toolCalls = log
    .getEntries()
    .filter(
      (record) => record.actor === "worker" && record.kind === "tool" && record.startedAt >= since,
    ).length;
  return summary;
}

export function buildUsageReport(
  context: ExtensionContext,
  log: ActivityLog,
  since?: number,
): Report {
  const rows = usageRows(context, log);
  const turns = rows.filter((row) => row.role === "worker" && row.timestamp >= (since ?? 0));
  return {
    version: 3,
    request: since === undefined ? undefined : summarize(rows, log, since),
    session: summarize(rows, log, 0),
    elapsedSeconds: since === undefined ? undefined : (Date.now() - since) / 1000,
    workerTurns: turns.slice(-USAGE_LIMITS.displayedWorkerTurns),
    omittedTurns: Math.max(0, turns.length - USAGE_LIMITS.displayedWorkerTurns),
  };
}

export function total(summary: Summary): { tokens: number | null; cost: number | null } {
  const roles = [summary.main, summary.worker, summary.decision, summary.summarizer];
  return {
    tokens: roles.reduce<number | null>((sum, role) => addKnown(sum, role.tokens), 0),
    cost: roles.reduce<number | null>((sum, role) => addKnown(sum, role.cost), 0),
  };
}
