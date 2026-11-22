import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { emptyTotals, mergeTotals } from "./accounting.ts";
import type { Measurement } from "./measurement.ts";
import type { Summary, Totals } from "./schema.ts";
export function roleTotals(summary: Summary): [string, Totals][] {
  const combined = emptyTotals();
  for (const role of [summary.main, summary.worker, summary.decision, summary.summarizer]) {
    mergeTotals(combined, role);
  }
  const roles: [string, Totals][] = [
    ["Main", summary.main],
    ["Worker", summary.worker],
    ["Decision", summary.decision],
    ["Summarizer", summary.summarizer],
  ];
  return [...roles.filter(([, totals]) => totals.requests > 0), ["Total", combined]];
}

export function usageRows(summary: Summary, expanded: boolean) {
  const headers = expanded
    ? ["Role", "Calls", "Input", "Cache R/W", "Output", "Tokens", "Cost"]
    : ["Role", "Calls", "Tokens", "Cost"];
  const rows = roleTotals(summary).map(([label, value]) => {
    const base = [label, numberText(value.requests)];
    if (expanded) {
      base.push(
        numberText(value.inputTotal),
        `${numberText(value.cacheRead)}/${numberText(value.cacheWrite)}`,
        numberText(value.output),
      );
    }
    return [...base, numberText(value.tokens), costText(value.cost, value.costSource)];
  });
  return { headers, rows };
}

function columnWidths(headers: string[], rows: string[][]): number[] {
  return headers.map((label, index) =>
    Math.max(visibleWidth(label), ...rows.map((row) => visibleWidth(row[index] ?? ""))),
  );
}

export function table(headers: string[], rows: string[][], width: number): string[] {
  const widths = columnWidths(headers, rows);
  return [headers, ...rows].map((row) =>
    truncateToWidth(
      row
        .map((value, index) => {
          const padding = " ".repeat(Math.max(0, (widths[index] ?? 0) - visibleWidth(value)));
          return index === 0 ? value + padding : padding + value;
        })
        .join("  ")
        .trimEnd(),
      width,
    ),
  );
}

export function summaryTable(summary: Summary, width: number, expanded = false): string[] {
  let selected = usageRows(summary, expanded);
  const size =
    columnWidths(selected.headers, selected.rows).reduce((sum, value) => sum + value, 0) +
    (selected.headers.length - 1) * 2;
  if (size > width) {
    selected = usageRows(summary, false);
  }
  if (width < 35) {
    selected = {
      headers: ["Role", "Tokens"],
      rows: roleTotals(summary).map(([label, value]) => [label, numberText(value.tokens)]),
    };
  }
  return table(selected.headers, selected.rows, width);
}

export function numberText(value: number | null): string {
  return value === null ? "?" : value.toLocaleString("en-US");
}

export function costText(value: number | null, source: Measurement["costSource"]): string {
  if (value === null || source === "unknown") {
    return "?";
  }
  const amount = value > 0 && value < 0.000001 ? value.toExponential(2) : value.toFixed(6);
  return `${source === "reported" ? "" : "~"}$${amount}`;
}
