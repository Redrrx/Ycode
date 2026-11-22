import type { ClassifierResult } from "@earendil-works/pi-ai";
import { z } from "zod";
import { DECISION_LIMITS } from "../config/constants.ts";
import type { Candidate } from "./request.ts";
const probabilitySchema = z.number().min(0).max(1);

function choiceSchema(candidateIds: string[]) {
  const allowedLabels = z.enum([...candidateIds, "none"]);
  return z.object({
    type: z.literal("choice"),
    choice: allowedLabels,
    confidence: probabilitySchema,
    probabilities: z.record(allowedLabels, probabilitySchema),
  });
}

export function parseRanking(result: ClassifierResult, candidates: Candidate[]) {
  if (result.stopReason !== "stop") {
    throw new Error(result.errorMessage || `Decision ${result.stopReason}`);
  }
  const schema = choiceSchema(candidates.map((candidate) => candidate.id));
  const parsed = schema.safeParse(result.answers.selected);
  if (!parsed.success) {
    throw new Error("Invalid decision selection, confidence, or probability distribution", {
      cause: parsed.error,
    });
  }
  const answer = parsed.data;
  const probabilities = Object.values(answer.probabilities);
  const totalProbability = probabilities.reduce((total, probability) => total + probability, 0);
  if (Math.abs(totalProbability - 1) > DECISION_LIMITS.probabilityTolerance) {
    throw new Error("Decision probabilities do not sum to one");
  }
  const scored = candidates.map((candidate) => {
    const probability = answer.probabilities[candidate.id];
    if (probability === undefined) {
      throw new Error(`Missing probability for ${candidate.id}`);
    }
    return { candidate, probability };
  });
  scored.sort((left, right) => right.probability - left.probability);
  return {
    abstained: answer.choice === "none",
    selected: answer.choice,
    ranked: scored.map((entry) => entry.candidate),
    probabilities: answer.probabilities,
  };
}
