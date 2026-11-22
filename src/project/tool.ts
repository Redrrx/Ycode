import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HistoryStore } from "./history.ts";
export function historyStoreTool(history: HistoryStore) {
  return defineTool({
    name: "work_history",
    label: "Change History",
    description:
      "List changes newest first. Use filters and cursor for paging. Select changeId for details. view=mutation includes linked input/output; offset continues long details. Excludes old answers, plans, and read logs. Not current source or Git history.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: Type.Object(
      {
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
        task: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        action: Type.Optional(
          Type.Union([Type.Literal("create"), Type.Literal("edit"), Type.Literal("mkdir")]),
        ),
        status: Type.Optional(
          Type.Union(
            (["pending", "applied", "retryable", "conflict", "not_applied"] as const).map(
              (status) => Type.Literal(status),
            ),
          ),
        ),
        since: Type.Optional(
          Type.String({ format: "date-time", description: "Inclusive ISO timestamp" }),
        ),
        until: Type.Optional(
          Type.String({ format: "date-time", description: "Inclusive ISO timestamp" }),
        ),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 20, description: "Headers per page; defaults to 8" }),
        ),
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 6000 })),
        changeId: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 120,
            description: "Fetch only this change; do not combine with filters",
          }),
        ),
        view: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("mutation")])),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Continue selected change details from nextOffset",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, parameters, signal) {
      signal?.throwIfAborted();
      const output = history.lookup(parameters);
      return { content: [{ type: "text", text: output }], details: undefined };
    },
  });
}
