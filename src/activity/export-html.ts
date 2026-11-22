import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SESSION_ENTRIES } from "../config/constants.ts";
import { buildUsageReport } from "../usage/accounting.ts";
import { usageRows } from "../usage/table.ts";
import { redact, safeText } from "./data.ts";
import type { ActivityLog } from "./log.ts";
import { toolIssueSummary } from "./tool-status.ts";
import type { ActivityDetail, ActivityRecord } from "./types.ts";
export function htmlText(text: string): string {
  return redact(safeText(text))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function detail(name: string, value: ActivityDetail | undefined): string {
  if (!value) {
    return "";
  }
  const flags = [value.truncated ? "truncated" : "", value.redacted ? "redacted" : ""].filter(
    Boolean,
  );
  return `<details><summary>${name}${flags.length ? ` (${flags.join(", ")})` : ""}</summary><pre>${htmlText(value.text)}</pre></details>`;
}

function activityStart(record: ActivityRecord, log: ActivityLog, details: boolean): string {
  const tools =
    record.kind === "task"
      ? log
          .getEntries()
          .filter(
            (item) =>
              item.runId === record.runId && item.actor === "worker" && item.kind === "tool",
          )
      : [];
  const counts =
    record.kind === "task"
      ? ` · ${tools.length} ${tools.length === 1 ? "tool" : "tools"}${toolIssueSummary(tools)}`
      : "";
  return `<details class="activity"><summary><span class="${record.status}">${htmlText(record.actor.toUpperCase())} · ${record.status}${htmlText(counts)}</span> · ${htmlText(record.title)}</summary><p class="meta">${htmlText(new Date(record.startedAt).toISOString())} · ${htmlText(record.id)}${record.model ? ` · ${htmlText(record.model)}` : ""}</p>${details ? detail("Input", record.input) + detail("Output", record.output) : ""}`;
}

function activityHtml(log: ActivityLog, details: boolean): string {
  const records = log.getEntries();
  const ids = new Set(records.map((record) => record.id));
  const children = new Map<string, ActivityRecord[]>();
  for (const record of records) {
    const parent = record.parentId && ids.has(record.parentId) ? record.parentId : "";
    const list = children.get(parent) ?? [];
    list.push(record);
    children.set(parent, list);
  }
  const visited = new Set<string>();
  const output: string[] = [];
  for (const root of [...(children.get("") ?? []), ...records]) {
    const stack = [{ record: root, close: false }];
    while (stack.length) {
      const item = stack.pop();
      if (!item) {
        break;
      }
      if (item.close) {
        output.push("</details>");
        continue;
      }
      if (visited.has(item.record.id)) {
        continue;
      }
      visited.add(item.record.id);
      output.push(activityStart(item.record, log, details));
      stack.push({ ...item, close: true });
      stack.push(
        ...(children.get(item.record.id) ?? [])
          .toReversed()
          .map((record) => ({ record, close: false })),
      );
    }
  }
  return output.join("\n");
}

function visibleText(content: string | { type: string; text?: string }[]): string {
  return Array.isArray(content)
    ? content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
    : content;
}

function conversationHtml(context: ExtensionContext): string {
  const output: string[] = [];
  for (const entry of context.sessionManager.getBranch()) {
    if (entry.type !== "message" && entry.type !== "custom_message") {
      continue;
    }
    if (entry.type === "custom_message") {
      if (
        [SESSION_ENTRIES.workerResult, SESSION_ENTRIES.review].some(
          (type) => type === entry.customType,
        )
      ) {
        const text = visibleText(entry.content);
        output.push(
          `<article><h3>${entry.customType === SESSION_ENTRIES.review ? "Review" : "Worker answer"}</h3><pre>${htmlText(text)}</pre></article>`,
        );
      }
      continue;
    }
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text = visibleText(message.content);
    if (text.trim()) {
      output.push(
        `<article><h3>${message.role === "user" ? "User" : "Main"}</h3><pre>${htmlText(text)}</pre></article>`,
      );
    }
  }
  return output.join("\n");
}

function usageHtml(context: ExtensionContext, log: ActivityLog): string {
  const { headers, rows } = usageRows(buildUsageReport(context, log).session, true);
  const head = headers.map((label) => `<th>${htmlText(label)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((value) => `<td>${htmlText(value)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const style = `body{font:16px/1.5 system-ui,sans-serif;background:#10151e;color:#e4e9f1;max-width:1100px;margin:auto;padding:24px}h1,h2,h3{line-height:1.3}article,.activity{border:1px solid #384356;border-radius:6px;margin:12px 0;padding:12px}details details{margin:8px 0 8px 12px}summary{cursor:pointer;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace}.meta{font-size:12px;color:#a4b1c7}.error,.failed{color:#ff9c9c}.warning,.partial,.limit{color:#ffd38a}.success{color:#a5e0ae}.table{overflow:auto}table{border-collapse:collapse;width:100%}td,th{padding:8px;border:1px solid #384356;text-align:right}th:first-child{text-align:left}p{overflow-wrap:anywhere}`;

export function sessionHtml(context: ExtensionContext, log: ActivityLog, details = false): string {
  const title = context.sessionManager.getSessionName() ?? "Ycode session";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'"><title>${htmlText(title)}</title><style>${style}</style></head><body><h1>${htmlText(title)}</h1><p class="meta">Session ${htmlText(context.sessionManager.getSessionId())} · ${log.getEntries().length} activity records · I/O: ${details ? "included" : "excluded"} · Redaction: best-effort</p><h2>Usage</h2>${usageHtml(context, log)}<h2>Conversation</h2>${conversationHtml(context)}<h2>Activity</h2>${activityHtml(log, details)}</body></html>`;
}
