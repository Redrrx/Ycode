import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { effortSchema, STORAGE_DIRECTORY } from "./constants.ts";
const roleSchema = z
  .object({
    model: z.string().trim(),
  })
  .strict();

const configSchema = z
  .object({
    worker: roleSchema.extend({ effort: effortSchema.optional() }),
    decision: roleSchema,
    summarizer: roleSchema.extend({ effort: effortSchema.optional() }),
    limits: z
      .object({
        workerTimeoutSeconds: z.int().positive().max(2_147_483),
        summarizerTimeoutSeconds: z.int().positive().max(2_147_483),
      })
      .strict(),
  })
  .strict();

export type RoleConfig = z.infer<typeof configSchema>;

const overridesSchema = z
  .object({
    worker: configSchema.shape.worker.partial().optional(),
    decision: roleSchema.partial().optional(),
    summarizer: configSchema.shape.summarizer.partial().optional(),
    limits: configSchema.shape.limits.partial().optional(),
  })
  .strict();

async function readOverrides(path: string) {
  try {
    return overridesSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    return overridesSchema.parse({});
  }
}

export async function saveRoleModel(role: "worker" | "decision" | "summarizer", model: string) {
  const dir = join(getAgentDir(), STORAGE_DIRECTORY);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.json");
  const settings = await readOverrides(path);
  settings[role] = { ...settings[role], model };
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function loadConfig(): Promise<RoleConfig> {
  const defaults = configSchema.parse(
    JSON.parse(await readFile(new URL("../../config.json", import.meta.url), "utf8")),
  );
  const overrides = await readOverrides(join(getAgentDir(), STORAGE_DIRECTORY, "config.json"));
  return configSchema.parse({
    worker: { ...defaults.worker, ...overrides.worker },
    decision: { ...defaults.decision, ...overrides.decision },
    summarizer: { ...defaults.summarizer, ...overrides.summarizer },
    limits: { ...defaults.limits, ...overrides.limits },
  });
}
