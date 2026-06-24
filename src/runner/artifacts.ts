import { mkdirSync, writeFileSync, existsSync, renameSync, readdirSync } from "fs";
import { join } from "path";
import type { BrowserContext, Page } from "playwright";
import type { ConsoleEntry, NetworkEntry } from "../types.js";

export interface ArtifactCollector {
  videoDir: string;
  screenshotDir: string;
  tracePath: string;
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  screenshots: string[];
}

export function createArtifactDirs(
  runDir: string,
  browser: string
): ArtifactCollector {
  const baseDir = join(runDir, browser);
  const videoDir = join(baseDir);
  const screenshotDir = join(baseDir, "screenshots");

  mkdirSync(screenshotDir, { recursive: true });

  return {
    videoDir,
    screenshotDir,
    tracePath: join(baseDir, "trace.zip"),
    consoleEntries: [],
    networkEntries: [],
    screenshots: [],
  };
}

export async function setupArtifacts(
  context: BrowserContext,
  page: Page,
  collector: ArtifactCollector
): Promise<void> {
  // Trace disabled by default (use --trace flag to enable)

  // Console listener
  page.on("console", (msg) => {
    collector.consoleEntries.push({
      type: msg.type() as ConsoleEntry["type"],
      message: msg.text(),
      source: msg.location().url || undefined,
      lineNumber: msg.location().lineNumber || undefined,
      timestamp: new Date().toISOString(),
    });
  });

  // Network listener
  page.on("response", (response) => {
    const status = response.status();
    const isFailure = status >= 400 || status === 0;
    collector.networkEntries.push({
      url: response.url(),
      method: response.request().method(),
      status,
      statusText: response.statusText(),
      durationMs: 0, // approximate
      isFailure,
      failureReason: isFailure ? getFailureReason(status) : undefined,
      timestamp: new Date().toISOString(),
    });
  });

  // Also catch failed requests (network errors)
  page.on("requestfailed", (request) => {
    collector.networkEntries.push({
      url: request.url(),
      method: request.method(),
      status: 0,
      statusText: request.failure()?.errorText ?? "Unknown",
      durationMs: 0,
      isFailure: true,
      failureReason: request.failure()?.errorText ?? "Request failed",
      timestamp: new Date().toISOString(),
    });
  });
}

export async function takeScreenshot(
  page: Page,
  collector: ArtifactCollector,
  name: string,
  fullPage: boolean = false
): Promise<string> {
  const filename = `${name}.png`;
  const filePath = join(collector.screenshotDir, filename);
  await page.screenshot({ path: filePath, fullPage });
  collector.screenshots.push(filename);
  return filePath;
}

export async function finalizeArtifacts(
  collector: ArtifactCollector,
  videoName?: string
): Promise<void> {
  // Write console log
  writeFileSync(
    join(collector.videoDir, "console.json"),
    JSON.stringify(collector.consoleEntries, null, 2)
  );

  // Write network log
  writeFileSync(
    join(collector.videoDir, "network.json"),
    JSON.stringify(collector.networkEntries, null, 2)
  );

  // Rename video from auto-generated name
  if (videoName) {
    try {
      const files = readdirSync(collector.videoDir);
      const videoFile = files.find(f => f.endsWith(".webm"));
      if (videoFile) {
        renameSync(
          join(collector.videoDir, videoFile),
          join(collector.videoDir, videoName)
        );
      }
    } catch {}
  }
}

function getFailureReason(status: number): string {
  if (status === 0) return "Network error or aborted";
  if (status === 404) return "Not Found";
  if (status === 500) return "Internal Server Error";
  if (status === 502) return "Bad Gateway";
  if (status === 503) return "Service Unavailable";
  if (status >= 400 && status < 500) return `Client error (${status})`;
  if (status >= 500) return `Server error (${status})`;
  return "Unknown";
}
