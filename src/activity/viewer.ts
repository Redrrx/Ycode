import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
export async function showText(
  context: ExtensionContext,
  text: string,
  title = "Activity inspector",
): Promise<void> {
  await context.ui.custom<void>((tui, theme, _keys, done) => {
    let offset = 0;
    let lineCount = 0;
    const pageSize = () => Math.max(1, tui.terminal.rows - 4);
    return {
      render(width) {
        const lines = new Text(text, 0, 0).render(width);
        lineCount = lines.length;
        offset = Math.max(0, Math.min(offset, lineCount - pageSize()));
        return [
          truncateToWidth(
            theme.fg("accent", `${title} · ↑/↓ PgUp/PgDn Home/End · Esc to close`),
            width,
          ),
          ...lines.slice(offset, offset + pageSize()),
          truncateToWidth(
            theme.fg(
              "dim",
              `Lines ${offset + 1} to ${Math.min(offset + pageSize(), lineCount)} / ${lineCount} · stored detail, no model context`,
            ),
            width,
          ),
        ];
      },
      handleInput(data) {
        if (matchesKey(data, "escape") || data === "q") {
          done();
          return;
        }
        for (const [key, amount] of [
          ["up", -1],
          ["down", 1],
          ["pageUp", -pageSize()],
          ["pageDown", pageSize()],
        ] as const) {
          if (matchesKey(data, key)) {
            offset += amount;
          }
        }
        if (matchesKey(data, "home")) {
          offset = 0;
        }
        if (matchesKey(data, "end")) {
          offset = lineCount;
        }
        tui.requestRender();
      },
      invalidate: () => undefined,
    };
  });
}
