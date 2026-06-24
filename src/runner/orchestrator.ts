import { mkdirSync } from "fs";
import { join } from "path";
import type { RunOptions, RunSummary, SiteResult, BrowserName } from "../types.js";
import { parseScenario } from "../engine/parser.js";
import { resolveVariables } from "../engine/variables.js";
import { compileSteps } from "../engine/compiler.js";
import { runWorker } from "./worker.js";
import { selectBranch, selectBranches } from "../tui/branch.js";
import { printConsoleReport } from "../reporter/console.js";
import { writeJsonReport } from "../reporter/json.js";
import { writeTextReport } from "../reporter/text.js";

export async function runAll(options: RunOptions): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const runTimestamp = formatTimestamp(new Date());

  // 1. Parse, resolve, compile
  const parsed = parseScenario(options.scenario);
  const resolved = await resolveVariables(parsed, options.clearCache, options.rememberLast);
  const steps = compileSteps(resolved);

  // Collect all branch choices UPFRONT before running
  const branchChoices = new Map<number, number | number[]>();
  for (const step of steps) {
    if (step.children) {
      const branchNames = Object.keys(step.children);
      const cacheKey = `branch:${options.scenario}:${step.index}`;
      const labels = step.childLabels
        ? branchNames.map(n => step.childLabels![n] ?? n)
        : undefined;
      if (step.childType === "checkbox") {
        branchChoices.set(step.index, await selectBranches(branchNames, step.index, cacheKey, labels, options.rememberLast));
      } else {
        branchChoices.set(step.index, await selectBranch(branchNames, step.index, cacheKey, labels, options.rememberLast));
      }
    }
  }

  // 2. Build (URL × browser) matrix
  const pairs: { url: string; browser: BrowserName }[] = [];
  for (const url of options.urls) {
    for (const browser of options.browsers) {
      pairs.push({ url, browser: browser as BrowserName });
    }
  }

  // 3. Shared runtime variable scope (for save_as)
  const runtimeVars = new Map<string, unknown>();

  const siteResults: RawSiteResult[] = [];

  // 4. Run: each site gets its own timestamped dir under scenario/
  //    output/{scenario}/{site}/{timestamp}/
  const scenarioSlug = slugify(parsed.name);
  const baseDir = join(options.outputDir, scenarioSlug);

  if (options.mode === "parallel") {
    // Parallel: all pairs run concurrently (with optional worker limit)
    const workers = options.maxWorkers || pairs.length;
    for (let i = 0; i < pairs.length; i += workers) {
      const chunk = pairs.slice(i, i + workers);
      const chunkResults = await Promise.all(
        chunk.map(({ url, browser }) =>
          runOne(steps, url, browser, options, baseDir, runTimestamp, runtimeVars, branchChoices)
        )
      );
      siteResults.push(...chunkResults);
    }
  } else {
    // Sequential
    for (const { url, browser } of pairs) {
      const result = await runOne(steps, url, browser, options, baseDir, runTimestamp, runtimeVars, branchChoices);
      siteResults.push(result);
    }
  }

  // 5. Aggregate results by site
  const aggregatedSites = aggregateBySite(siteResults, options.urls);

  const finishedAt = new Date().toISOString();
  const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  // 6. Count totals
  let totalSteps = 0, passedSteps = 0, failedSteps = 0;
  for (const sr of aggregatedSites) {
    for (const br of sr.browsers) {
      totalSteps += br.steps.length;
      passedSteps += br.steps.filter((s) => s.status === "pass").length;
      failedSteps += br.steps.filter((s) => s.status === "fail" || s.status === "error").length;
    }
  }

  const summary: RunSummary = {
    startedAt,
    finishedAt,
    durationMs,
    scenario: options.scenario,
    scenarioName: parsed.name,
    sites: aggregatedSites,
    totals: {
      sites: aggregatedSites.length,
      browsers: pairs.length,
      steps: totalSteps,
      passed: passedSteps,
      failed: failedSteps,
    },
  };

  // 7. Generate reports
  printConsoleReport(summary, options);
  for (const site of aggregatedSites) {
    const siteHost = new URL(site.url).hostname;
    const siteDir = join(baseDir, siteHost, runTimestamp);
    // Write site-level report
    const siteSummary: RunSummary = {
      ...summary,
      sites: [site],
      totals: {
        sites: 1,
        browsers: site.browsers.length,
        steps: site.browsers.reduce((s, b) => s + b.steps.length, 0),
        passed: site.browsers.reduce((s, b) => s + b.steps.filter(st => st.status === "pass").length, 0),
        failed: site.browsers.reduce((s, b) => s + b.steps.filter(st => st.status === "fail" || st.status === "error").length, 0),
      },
    };
    writeJsonReport(siteSummary, siteDir);
    writeTextReport(siteSummary, siteDir);
  }

  return summary;
}

interface RawSiteResult {
  url: string;
  browser: BrowserName;
  result: Awaited<ReturnType<typeof runWorker>>;
}

async function runOne(
  steps: ReturnType<typeof compileSteps>,
  url: string,
  browser: BrowserName,
  options: RunOptions,
  baseDir: string,
  runTimestamp: string,
  runtimeVars: Map<string, unknown>,
  branchChoices: Map<number, number | number[]>
): Promise<RawSiteResult> {
  if (options.verbose) {
    console.log(`\n▶ ${url} [${browser}]`);
  }

  const siteHost = new URL(url).hostname;
  const runDir = join(baseDir, siteHost, runTimestamp);

  const result = await runWorker(steps, url, browser, options, runDir, runtimeVars, options.scenario, branchChoices);

  const statusIcon = result.status === "pass" ? "✅" : "❌";
  console.log(
    `  ${statusIcon} ${url} / ${browser}  (${result.steps.filter((s) => s.status === "pass").length}/${result.steps.length} steps, ${(result.durationMs / 1000).toFixed(1)}s)`
  );

  if (result.status !== "pass" && options.verbose) {
    for (const step of result.steps) {
      if (step.status === "fail" || step.status === "error") {
        console.log(`     ↳ Step ${step.index} (${step.type}): ${step.error}`);
      }
    }
  }

  return { url, browser, result };
}

function aggregateBySite(raw: RawSiteResult[], urls: string[]): SiteResult[] {
  const map = new Map<string, RawSiteResult[]>();
  for (const r of raw) {
    const existing = map.get(r.url) || [];
    existing.push(r);
    map.set(r.url, existing);
  }

  return urls.map((url) => {
    const entries = map.get(url) || [];
    const browsers = entries.map((e) => e.result);
    const total = browsers.reduce((sum, b) => sum + b.steps.length, 0);
    const passed = browsers.reduce(
      (sum, b) => sum + b.steps.filter((s) => s.status === "pass").length,
      0
    );
    const failed = total - passed;
    const allPassed = browsers.every((b) => b.status === "pass");
    const anyError = browsers.some((b) => b.status === "error");

    return {
      url,
      status: anyError ? "error" : allPassed ? "pass" : "fail",
      durationMs: browsers.reduce((sum, b) => sum + b.durationMs, 0),
      browsers,
      summary: { passed, failed, total },
    };
  });
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
