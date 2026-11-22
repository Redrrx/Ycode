import { z } from "zod";
import { changeHeadSchema } from "../project/changes.ts";
const listSchema = z.object({
  changes: z.array(changeHeadSchema),
  nextCursor: z.string().nullable(),
});
const detailSchema = z.object({ change: changeHeadSchema.nullable() });

function heading(change: z.infer<typeof changeHeadSchema>): string {
  return `${change.at} · ${change.action} · ${change.path} · ${change.status}`;
}

export function changeHistoryText(value: unknown): string | undefined {
  const list = listSchema.safeParse(value);
  if (list.success) {
    return [
      `${list.data.changes.length} change headers · newest first`,
      ...list.data.changes.flatMap((change) => [
        heading(change),
        `  ${change.description} · ID ${change.id}`,
      ]),
      ...(list.data.nextCursor ? ["More changes available using nextCursor."] : []),
      "Saved write attempts, not current source. Select a changeId for details.",
    ].join("\n");
  }
  const detail = detailSchema.safeParse(value);
  if (detail.success) {
    if (!detail.data.change) {
      return "Change not found.";
    }
    return [
      heading(detail.data.change),
      detail.data.change.description,
      `ID: ${detail.data.change.id} · Task: ${detail.data.change.task}`,
      "Selected write details:",
      JSON.stringify(value, null, 2),
    ].join("\n");
  }
  return undefined;
}
