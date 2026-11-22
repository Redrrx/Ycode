import { z } from "zod";
import { TOOL_NAMES } from "../config/constants.ts";
import { COVERAGE_NOTE } from "../tools/explore/result.ts";
const findingSchema = z.looseObject({
  path: z.string(),
  sourceHash: z.string(),
  content: z.string(),
});
const resultSchema = z.looseObject({
  workspaceId: z.string(),
  findings: z.array(findingSchema),
  warnings: z.array(z.string()).optional(),
  coverage: z.record(z.string(), z.number()).optional(),
  workspaces: z.array(z.looseObject({ id: z.string() })).optional(),
});
const objectSchema = z.record(z.string(), z.unknown());
const arraySchema = z.array(z.unknown());
const analysisSchema = z.looseObject({ status: z.string() });
const explorationTools = new Set<string>([
  TOOL_NAMES.overview,
  TOOL_NAMES.find,
  TOOL_NAMES.inspect,
]);
const diagnosticCounts = new Set([
  "inventoriedFiles",
  "uniqueExaminedFiles",
  "outlineOperations",
  "referenceASTOperations",
  "successfulReadOperations",
  "rootDirectoryEntries",
  "inspectionAttempts",
  "findingsThisCall",
]);

type Finding = z.infer<typeof findingSchema>;
type Result = z.infer<typeof resultSchema>;

function compactAnalysis(value: unknown): unknown {
  const parsed = analysisSchema.safeParse(value);
  if (!parsed.success) {
    return value;
  }
  const output = { ...parsed.data };
  if (output.offset === 0) {
    delete output.offset;
  }
  if (["unsupported", "unavailable"].includes(output.status) && output.total === 0) {
    delete output.total;
    if (output.nextOffset === null) {
      delete output.nextOffset;
    }
  }
  return output;
}

function compactFinding(finding: Finding): Record<string, unknown> {
  const output: Record<string, unknown> = { ...finding };
  for (const key of ["declarations", "references", "unresolvedReferences"]) {
    const parsed = arraySchema.safeParse(output[key]);
    if (parsed.success && parsed.data.length === 0) {
      delete output[key];
    }
  }
  if (output.truncated === false) {
    delete output.truncated;
  }
  if (output.kind === "source") {
    delete output.kind;
  }
  if (output.referenceAnalysis !== undefined) {
    output.referenceAnalysis = compactAnalysis(output.referenceAnalysis);
  }
  return output;
}

interface SearchContextData {
  readonly sources: Map<string, string>;
  readonly metadata: Map<string, string>;
  readonly notices: Set<string>;
}

export type SearchContext = Pick<ReturnType<typeof bindSearchContext>, "project">;

export function createSearchContext(): SearchContext {
  return bindSearchContext({
    sources: new Map<string, string>(),
    metadata: new Map<string, string>(),
    notices: new Set<string>(),
  });
}

function bindSearchContext(self: SearchContextData) {
  return Object.assign(self, {
    project: searchContextProject.bind(undefined, self),
  });
}

function searchContextProject(
  self: SearchContextData,
  tool: string,
  text: string,
  call: string,
): string | undefined {
  if (!explorationTools.has(tool)) {
    return undefined;
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = resultSchema.safeParse(input);
  return parsed.success ? JSON.stringify(searchContextResult(self, parsed.data, call)) : undefined;
}

function searchContextFinding(
  self: SearchContextData,
  workspace: string,
  finding: Finding,
  call: string,
) {
  const key = JSON.stringify([workspace, finding]);
  const duplicateOf = self.sources.get(key);
  if (duplicateOf) {
    return { path: finding.path, sourceHash: finding.sourceHash, duplicateOf };
  }
  self.sources.set(key, call);
  return compactFinding(finding);
}

function searchContextChanged(self: SearchContextData, key: string, value: unknown): boolean {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || self.metadata.get(key) === serialized) {
    return false;
  }
  self.metadata.set(key, serialized);
  return true;
}

function searchContextNotice(self: SearchContextData, value: string, kind = "note"): boolean {
  const key = JSON.stringify([kind, value]);
  if (self.notices.has(key)) {
    return false;
  }
  self.notices.add(key);
  return true;
}

function searchContextEnvelope(
  self: SearchContextData,
  output: Record<string, unknown>,
  result: Result,
): void {
  delete output.goal;
  delete output.decisionCalls;
  delete output.workspaceCount;
  for (const key of ["workspace", "scope"]) {
    if (
      !searchContextChanged(self, JSON.stringify(["scope", result.workspaceId, key]), output[key])
    ) {
      delete output[key];
    }
  }
  if (result.coverage) {
    const coverage = Object.fromEntries(
      Object.entries(result.coverage).filter(([key]) => !diagnosticCounts.has(key)),
    );
    if (Object.keys(coverage).length) {
      output.coverage = coverage;
    } else {
      delete output.coverage;
    }
  }
  if (result.findings.length === 0) {
    delete output.findings;
  }
  if (result.warnings?.length === 0) {
    delete output.warnings;
  }
}

function searchContextAnnotations(
  self: SearchContextData,
  output: Record<string, unknown>,
  result: Result,
): void {
  const note = z.string().safeParse(output.note);
  const noteScope =
    note.success && note.data === COVERAGE_NOTE
      ? "note"
      : JSON.stringify(["note", result.workspaceId, result.workspace, result.scope]);
  if (note.success && !searchContextNotice(self, note.data, noteScope)) {
    delete output.note;
  }
  const structure = objectSchema.safeParse(output.structure);
  if (structure.success) {
    const value = { ...structure.data };
    const note = z.string().safeParse(value.note);
    if (note.success && !searchContextNotice(self, note.data, "structure")) {
      delete value.note;
    }
    output.structure = value;
  }
  if (result.workspaces) {
    const workspaces = result.workspaces.filter((workspace) =>
      searchContextChanged(self, JSON.stringify(["workspace", workspace.id]), workspace),
    );
    if (workspaces.length) {
      output.workspaces = workspaces;
    } else {
      delete output.workspaces;
    }
  }
}

function searchContextResult(
  self: SearchContextData,
  result: Result,
  call: string,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    ...result,
    findings: result.findings.map((finding) =>
      searchContextFinding(self, result.workspaceId, finding, call),
    ),
  };
  searchContextEnvelope(self, output, result);
  searchContextAnnotations(self, output, result);
  return output;
}
