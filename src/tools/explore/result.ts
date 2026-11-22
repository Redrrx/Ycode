import { EXPLORATION_LIMITS as LIMITS } from "../../config/constants.ts";
export interface Finding {
  path: string;
  sourceHash: string;
  kind: "source" | "manifest";
  declarations: { name: string; kind: string; line: number }[];
  references: string[];
  unresolvedReferences: string[];
  referenceAnalysis?: {
    status: "analyzed" | "partial" | "unsupported" | "unavailable";
    total: number;
    offset: number;
    nextOffset: number | null;
    notes?: string[];
  };
  content: string;
  truncated: boolean;
  segment?: { startOffset: number; endOffset: number; startLine: number };
  range?: {
    startLine: number;
    endLine: number;
    nextLine: number | null;
    partialLine?: number;
  };
}

export interface ExplorationResult {
  workspaceId: string;
  goal: string;
  workspace: string;
  scope: string;
  status: "findings" | "partial" | "empty";
  stopReason: string;
  findings: Finding[];
  tree?: string;
  coverage: Record<string, number>;
  decisionCalls: number;
  warnings: string[];
  notices?: string[];
  note: string;
}

export const COVERAGE_NOTE =
  "Paths are workspace-relative. Inventory respects ignore rules and exclusions; it does not prove absence. code_inspect can read any known text path inside scope, including documentation and configuration outside the inventory. Binary or oversized files are rejected. No cross-task source cache.";

export function shortenFinding(finding: Finding): void {
  const shorter = finding.content.slice(0, Math.floor(finding.content.length / 2));
  if (!finding.range) {
    finding.content = shorter;
    if (finding.segment) {
      finding.segment.endOffset = finding.segment.startOffset + shorter.length;
    }
  } else {
    const last = [...shorter.matchAll(/^(\d+):[^\n]*\n/gmu)].at(-1);
    const endLine = last?.[1] ? Number(last[1]) : finding.range.startLine - 1;
    finding.content = last ? shorter.slice(0, last.index + last[0].length) : "";
    finding.range = {
      startLine: finding.range.startLine,
      endLine,
      nextLine: endLine + 1,
    };
  }
  finding.truncated = true;
}

export function fitResult<T extends ExplorationResult>(result: T): T {
  const output = structuredClone(result);
  if (Buffer.byteLength(JSON.stringify(output)) <= LIMITS.outputBytes) {
    return output;
  }
  output.warnings.push(
    "Source excerpts shortened to fit the output limit. Continue numbered reads at range.nextLine; if no complete line fits, inspect fewer files together. Other excerpts can be read with code_inspect.",
  );
  output.status = "partial";
  while (Buffer.byteLength(JSON.stringify(output)) > LIMITS.outputBytes) {
    const largest = [...output.findings].sort((a, b) => b.content.length - a.content.length)[0];
    if (!largest || largest.content.length === 0) {
      throw new Error("Result metadata exceeds the output budget; narrow the scope");
    }
    shortenFinding(largest);
  }
  return output;
}
