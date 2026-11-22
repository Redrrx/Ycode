import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { STORAGE_DIRECTORY } from "../config/constants.ts";
import { sessionHtml } from "./export-html.ts";
import type { ActivityLog } from "./log.ts";
export async function exportActivity(
  context: ExtensionContext,
  log: ActivityLog,
  args: string,
): Promise<string> {
  const input = args.trim();
  const details = /^--details(?:\s|$)/u.test(input);
  const requested = (details ? input.slice("--details".length) : input).trim();
  let path: string;
  if (requested) {
    path = resolve(context.cwd, requested);
  } else {
    const directory = join(getAgentDir(), STORAGE_DIRECTORY, "exports");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    path = join(directory, `ycode-${randomUUID()}.html`);
  }
  const html = sessionHtml(context, log, details);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(html, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}
