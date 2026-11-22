import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { DECISION_LIMITS } from "../config/constants.ts";
function validateCandidates(candidates: Candidate[]): void {
  if (candidates.length === 0 || candidates.length > DECISION_LIMITS.candidates) {
    throw new Error(`Expected 1 to ${DECISION_LIMITS.candidates} candidates`);
  }
  const ids = new Set(candidates.map((candidate) => candidate.id));
  if (ids.size !== candidates.length || ids.has("none")) {
    throw new Error("Invalid candidate IDs");
  }
}

export function createDecisionRequest(
  question: DecisionQuestion,
  target: string,
  candidates: Candidate[],
  context?: Record<string, string | string[]>,
): ClassifierContext {
  validateCandidates(candidates);
  const criteria: Record<string, string> = { none: "No supported candidate" };
  for (const candidate of candidates) {
    criteria[candidate.id] = `Candidate ${candidate.id}`;
  }
  return {
    state: {
      target,
      context: context ?? null,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        description: candidate.description,
      })),
    },
    questions: {
      selected: { type: "choice", instructions: question.instructions, criteria },
    },
  };
}

export type Classify = (
  request: ClassifierContext,
  signal: AbortSignal,
) => Promise<ClassifierResult>;

export interface Candidate {
  id: string;
  description: string;
}

export interface DecisionQuestion {
  stage: string;
  instructions: string;
}

export type Stage = DecisionQuestion["stage"];

export interface DecisionSpan {
  complete(result: ClassifierResult): void;
  fail(error: unknown, result: ClassifierResult | undefined, cancelled: boolean): void;
}

export type ObserveDecision = (
  stage: Stage,
  request: ClassifierContext,
  candidates: Candidate[],
) => DecisionSpan;
