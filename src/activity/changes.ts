import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { changePageSchema } from "../project/changes.ts";
import type { HistoryStore } from "../project/history.ts";
import { safeText } from "./data.ts";
import { showText } from "./viewer.ts";
function title(query: string): string {
  return `Changes · newest first${query ? ` · ${safeText(query)}` : ""}`;
}

export async function showChanges(
  context: ExtensionContext,
  history: HistoryStore,
  initialQuery: string,
): Promise<void> {
  let query = initialQuery.trim();
  let cursor: string | undefined;
  const previous: (string | undefined)[] = [];
  for (;;) {
    const page = changePageSchema.parse(
      JSON.parse(history.lookup({ query: query || undefined, cursor })),
    );
    const labels = page.changes.map((change) =>
      safeText(
        `${change.at} · ${change.status} · ${change.action} ${change.path}: ${change.description} · ${change.id}`,
      ),
    );
    const choices = [...labels, "Search changes…"];
    if (previous.length) {
      choices.push("Newer changes…");
    }
    if (page.nextCursor) {
      choices.push("Older changes…");
    }
    const selected = await context.ui.select(title(query), choices);
    if (selected === undefined) {
      return;
    }
    if (selected === "Search changes…") {
      const next = await context.ui.input("Search path, description or task", query);
      if (next !== undefined) {
        query = next.trim();
        cursor = undefined;
        previous.length = 0;
      }
      continue;
    }
    if (selected === "Newer changes…") {
      cursor = previous.pop();
      continue;
    }
    if (selected === "Older changes…") {
      previous.push(cursor);
      cursor = page.nextCursor ?? undefined;
      continue;
    }
    const change = page.changes[labels.indexOf(selected)];
    if (change) {
      await showText(context, safeText(history.inspectChange(change.id)), "Selected change");
    }
  }
}
