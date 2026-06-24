import { writeFileSync } from "fs";
import { join } from "path";
import type { RunSummary } from "../types.js";

export function writeTextReport(summary: RunSummary, runDir: string): void {
  const lines: string[] = [];

  lines.push("=".repeat(60));
  lines.push("  BATMAN — Test Run Report");
  lines.push("=".repeat(60));
  lines.push("");
  lines.push(`Scenario : ${summary.scenarioName}`);
  lines.push(`File     : ${summary.scenario}`);
  lines.push(`Started  : ${summary.startedAt}`);
  lines.push(`Finished : ${summary.finishedAt}`);
  lines.push(`Duration : ${formatDuration(summary.durationMs)}`);
  lines.push("");
  lines.push(`Results: ${summary.totals.passed} passed, ${summary.totals.failed} failed, ${summary.totals.steps} total`);
  lines.push(`Sites: ${summary.totals.sites} | Browsers: ${summary.totals.browsers}`);
  lines.push("");

  for (const site of summary.sites) {
    lines.push("-".repeat(60));
    lines.push(`Site: ${site.url}  [${site.status.toUpperCase()}]  (${formatDuration(site.durationMs)})`);
    lines.push("-".repeat(60));

    for (const browser of site.browsers) {
      const icon = browser.status === "pass" ? "PASS" : "FAIL";
      lines.push(`\n  Browser: ${browser.browser}  [${icon}]  ${formatDuration(browser.durationMs)}`);
      lines.push(`  ────────────────────────────────────────`);

      for (const step of browser.steps) {
        const stepIcon = step.status === "pass" ? "✓"
          : step.status === "skip" ? "○"
            : "✗";
        const line = `  ${stepIcon} Step ${String(step.index).padStart(3)} | ${step.type.padEnd(25)} | ${formatDuration(step.durationMs).padStart(8)}`;
        lines.push(line);

        if (step.error) {
          lines.push(`       Error: ${step.error}`);
        }
        if (step.screenshot) {
          lines.push(`       Screenshot: ${step.screenshot}`);
        }
      }

      // Console errors
      const consoleErrors = browser.consoleEntries.filter((e) => e.type === "error");
      if (consoleErrors.length > 0) {
        lines.push(`\n  Console Errors (${consoleErrors.length}):`);
        for (const e of consoleErrors) {
          lines.push(`    [${e.type}] ${e.message}`);
        }
      }

      // Network failures
      const netFailures = browser.networkEntries.filter((e) => e.isFailure);
      if (netFailures.length > 0) {
        lines.push(`\n  Network Failures (${netFailures.length}):`);
        for (const f of netFailures) {
          lines.push(`    ${f.method} ${f.url} → ${f.status} ${f.statusText}`);
        }
      }

      // Artifacts
      lines.push(`\n  Artifacts:`);
      lines.push(`    Video     : ${browser.artifacts.video}`);
      lines.push(`    Trace     : ${browser.artifacts.trace}`);
      lines.push(`    Console   : ${browser.artifacts.console}`);
      lines.push(`    Network   : ${browser.artifacts.network}`);
      if (browser.artifacts.screenshots.length > 0) {
        lines.push(`    Screenshots (${browser.artifacts.screenshots.length}):`);
        for (const s of browser.artifacts.screenshots) {
          lines.push(`      ${s}`);
        }
      }
    }
  }

  lines.push("");
  lines.push("=".repeat(60));
  lines.push(summary.totals.failed === 0 ? "  STATUS: ALL PASSED" : "  STATUS: FAILURES DETECTED");
  lines.push("=".repeat(60));

  writeFileSync(join(runDir, "report.txt"), lines.join("\n"));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}
