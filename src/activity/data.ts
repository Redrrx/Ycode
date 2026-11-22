import type { ClassifierResult, Usage } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { z } from "zod";
import { ACTIVITY_LIMITS } from "../config/constants.ts";
import type { Candidate, Stage } from "../decision/request.ts";
import { measuredUsage } from "../usage/measurement.ts";
import type { ActivityDetail, ActivityUsage } from "./types.ts";
const stringSchema = z.string();
const sensitiveAssignment =
  /((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,}]+)/gi;

function replaceControlCharacters(text: string): string {
  return text.replace(/\p{Cc}+/gu, " ");
}

export function safeText(text: string): string {
  return stripTerminalSequences(text).split("\n").map(replaceControlCharacters).join("\n");
}

export function redact(text: string): string {
  return text
    .replace(/\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(sensitiveAssignment, '$1"[REDACTED]"');
}

function serialize(value: unknown): string {
  const text = stringSchema.safeParse(value);
  if (text.success) {
    return text.data;
  }
  try {
    return JSON.stringify(value, null, 2) ?? "[No serializable value]";
  } catch {
    return "[Activity value could not be serialized]";
  }
}

export function activityDetail(value: unknown): ActivityDetail {
  const original = serialize(value);
  const scrubbed = redact(original);
  const bytes = Buffer.from(safeText(scrubbed), "utf8");

  return {
    text: bytes.subarray(0, ACTIVITY_LIMITS.detailBytes).toString("utf8"),
    truncated: bytes.length > ACTIVITY_LIMITS.detailBytes,
    redacted: scrubbed !== original,
  };
}

export function activityTitle(text: string): string {
  return replaceControlCharacters(redact(stripTerminalSequences(text))).slice(
    0,
    ACTIVITY_LIMITS.titleChars,
  );
}

export function activityUsage(usage: Usage | undefined): ActivityUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return measuredUsage(usage);
}

const argumentsSchema = z.object({
  path: z.string().optional(),
  command: z.string().optional(),
  target: z.string().optional(),
  pattern: z.string().optional(),
});

const outputSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

export function formatToolTitle(name: string, args: unknown): string {
  const parsed = argumentsSchema.safeParse(args);
  if (!parsed.success) {
    return name;
  }
  const values = parsed.data;
  const target = values.path ?? values.command ?? values.target ?? values.pattern;
  return target ? `${name} · ${target}` : name;
}

export function extractToolOutput(result: unknown): unknown {
  const parsed = outputSchema.safeParse(result);
  if (!parsed.success) {
    return result;
  }
  const text = parsed.data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  return text || "[No text output; non-text content is not recorded]";
}

export function formatDecisionTitle(
  stage: Stage,
  result: ClassifierResult,
  candidates: Candidate[],
): string {
  const answer = result.answers.selected;
  if (answer?.type !== "choice") {
    const probabilities = Object.entries(result.answers)
      .filter(
        (entry): entry is [string, Extract<(typeof entry)[1], { type: "bool" }>] =>
          entry[1].type === "bool",
      )
      .sort((left, right) => right[1].probability - left[1].probability);
    const labels = probabilities.slice(0, 3).map(([id, value]) => {
      const label =
        candidates.find((candidate) => candidate.id === id)?.description.split("\n")[0] ?? id;
      return `${label}: ${value.probability.toFixed(2)}`;
    });
    return `${stage} → ${labels.join("; ") || "response"}`;
  }
  if (answer.choice === "none") {
    return `${stage} → abstained`;
  }
  const candidate = candidates.find((item) => item.id === answer.choice);
  const label = candidate?.description.split("\n").at(0) ?? answer.choice;
  return `${stage} → ${label} · confidence ${answer.confidence.toFixed(2)}`;
}
