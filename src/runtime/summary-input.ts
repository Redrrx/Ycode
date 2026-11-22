import {
  convertToLlm,
  prepareBranchEntries,
  serializeConversation,
  type FileOperations,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { summarizerInstructions } from "../prompts.ts";
const filesSchema = z.object({
  readFiles: z.array(z.string()).default([]),
  modifiedFiles: z.array(z.string()).default([]),
});

export interface SummaryInput {
  prompt: string;
  readFiles: string[];
  modifiedFiles: string[];
}

function carryFiles(fileOps: FileOperations, entries: SessionEntry[]): void {
  for (const entry of entries) {
    if (entry.type !== "compaction" && entry.type !== "branch_summary") {
      continue;
    }
    const parsed = filesSchema.safeParse(entry.details);
    if (parsed.success) {
      parsed.data.readFiles.forEach((path) => fileOps.read.add(path));
      parsed.data.modifiedFiles.forEach((path) => fileOps.edited.add(path));
    }
  }
}

function input(prompt: string, fileOps: FileOperations): SummaryInput {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    prompt,
    readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

export function compactionInput(event: SessionBeforeCompactEvent): SummaryInput {
  const preparation = event.preparation;
  const fileOps: FileOperations = {
    read: new Set(preparation.fileOps.read),
    edited: new Set(preparation.fileOps.edited),
    written: new Set(preparation.fileOps.written),
  };
  const previous = event.branchEntries.findLast((entry) => entry.type === "compaction");
  carryFiles(fileOps, previous ? [previous] : []);
  const history = serializeConversation(convertToLlm(preparation.messagesToSummarize));
  const prefix = serializeConversation(convertToLlm(preparation.turnPrefixMessages));
  const prompt = [
    `<previous-summary>\n${preparation.previousSummary ?? ""}\n</previous-summary>`,
    `<conversation>\n${history}\n</conversation>`,
    `<split-turn-prefix>\n${prefix}\n</split-turn-prefix>`,
    summarizerInstructions,
    event.customInstructions ? `Additional instructions: ${event.customInstructions}` : "",
  ].join("\n\n");
  return input(prompt, fileOps);
}

export function branchInput(event: SessionBeforeTreeEvent): SummaryInput {
  const { entriesToSummarize, customInstructions, replaceInstructions } = event.preparation;
  const prepared = prepareBranchEntries(entriesToSummarize);
  carryFiles(prepared.fileOps, entriesToSummarize);
  const conversation = serializeConversation(convertToLlm(prepared.messages));
  const instructions =
    replaceInstructions && customInstructions
      ? customInstructions
      : `${summarizerInstructions}\n\n${customInstructions ?? ""}`;
  return input(
    `<conversation>\n${conversation}\n</conversation>\n\n${instructions}`,
    prepared.fileOps,
  );
}

export function appendSummaryFiles(summary: string, prepared: SummaryInput): string {
  const sections = [summary];
  if (prepared.readFiles.length) {
    sections.push(`<read-files>\n${prepared.readFiles.join("\n")}\n</read-files>`);
  }
  if (prepared.modifiedFiles.length) {
    sections.push(`<modified-files>\n${prepared.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.join("\n\n");
}
