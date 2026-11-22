import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
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

export async function loadConfig(): Promise<RoleConfig> {
  const defaults = configSchema.parse(
    JSON.parse(await readFile(new URL("../../config.json", import.meta.url), "utf8")),
  );
  let overrides = overridesSchema.parse({});
  try {
    overrides = overridesSchema.parse(
      JSON.parse(await readFile(join(getAgentDir(), STORAGE_DIRECTORY, "config.json"), "utf8")),
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  return configSchema.parse({
    worker: { ...defaults.worker, ...overrides.worker },
    decision: { ...defaults.decision, ...overrides.decision },
    summarizer: { ...defaults.summarizer, ...overrides.summarizer },
    limits: { ...defaults.limits, ...overrides.limits },
  });
}
