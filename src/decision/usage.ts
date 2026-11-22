import type { Usage } from "@earendil-works/pi-ai";
import {
  measuredUsage,
  rememberUsage,
  sumUsage,
  unknownUsage,
  zeroUsage,
} from "../usage/measurement.ts";
export function emptyUsage(): Usage {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  rememberUsage(usage, zeroUsage());
  return usage;
}

export function addUsage(total: Usage, added: Usage | undefined): void {
  rememberUsage(
    total,
    sumUsage(measuredUsage(total), added ? measuredUsage(added) : unknownUsage()),
  );
  if (!added) {
    return;
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    total[key] += added[key];
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    total.cost[key] += added.cost[key];
  }
}
