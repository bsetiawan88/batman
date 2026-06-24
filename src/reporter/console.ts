import chalk from "chalk";
import type { RunOptions, RunSummary, SiteResult, BrowserResult, StepResult } from "../types.js";

export function printConsoleReport(summary: RunSummary, options: RunOptions): void {
  console.log(chalk.bold("\n═══════════════════════════════════════"));
  console.log(chalk.bold("  BATMAN — Run Report"));
  console.log(chalk.bold("═══════════════════════════════════════\n"));

  // Summary header
  const totalIcon = summary.totals.failed === 0 ? chalk.green("✅ ALL PASSED") : chalk.red("❌ FAILURES");
  console.log(`  ${totalIcon}`);
  console.log(`  Scenario : ${summary.scenarioName}`);
  console.log(`  Duration : ${formatDuration(summary.durationMs)}`);
  console.log(`  Sites    : ${summary.totals.sites}  |  Browsers : ${summary.totals.browsers}`);
  console.log(`  Steps    : ${summary.totals.passed} passed / ${summary.totals.failed} failed / ${summary.totals.steps} total\n`);

  // Per-site breakdown
  for (const site of summary.sites) {
    const siteIcon = site.status === "pass" ? chalk.green("PASS") : chalk.red("FAIL");
    console.log(chalk.bold(`  ── ${site.url}  [${siteIcon}]  (${formatDuration(site.durationMs)})`));

    for (const browser of site.browsers) {
      const browserIcon = browser.status === "pass" ? chalk.green("✓") : chalk.red("✗");
      const passedCount = browser.steps.filter((s) => s.status === "pass").length;
      console.log(
        `     ${browserIcon} ${browser.browser.padEnd(10)} ${passedCount}/${browser.steps.length} steps  ${formatDuration(browser.durationMs)}`
      );

      // Show failed steps
      const failures = browser.steps.filter((s) => s.status === "fail" || s.status === "error");
      for (const step of failures) {
        console.log(chalk.red(`       ↳ Step ${step.index} (${step.type}): ${step.error || "unknown error"}`));
      }
    }
    console.log();
  }

  console.log(chalk.dim(`  Output: ${options.outputDir}`));
  console.log(chalk.bold("═══════════════════════════════════════\n"));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}
