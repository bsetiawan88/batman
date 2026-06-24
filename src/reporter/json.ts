import { writeFileSync } from "fs";
import { join } from "path";
import type { RunSummary } from "../types.js";

export function writeJsonReport(summary: RunSummary, runDir: string): void {
  const json = JSON.stringify(summary, null, 2);
  writeFileSync(join(runDir, "summary.json"), json);
}
