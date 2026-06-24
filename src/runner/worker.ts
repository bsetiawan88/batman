import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { join, resolve } from "path";
import { writeFileSync } from "fs";
import type { CompiledStep, BrowserResult, StepResult, RunOptions, BrowserName } from "../types.js";
import {
  createArtifactDirs,
  setupArtifacts,
  takeScreenshot,
  finalizeArtifacts,
  type ArtifactCollector,
} from "./artifacts.js";
import { selectBranch, selectBranches } from "../tui/branch.js";

// Module-level dialog flags
let acceptNextDialog = false;
let acceptDialogText: string | undefined;
import {
  assertElement,
  assertText,
  assertUrl,
  assertCount,
  assertVisible,
  assertHidden,
  assertValue,
  assertNoConsoleError,
  assertNoFailedRequest,
  assertJson,
  assertDb,
} from "../engine/assertions.js";

export async function runWorker(
  steps: CompiledStep[],
  siteUrl: string,
  browserName: BrowserName,
  options: RunOptions,
  runDir: string,
  runtimeVars: Map<string, unknown>,
  scenarioPath: string,
  branchChoices: Map<number, number | number[]>
): Promise<BrowserResult> {
  const startedAt = new Date().toISOString();
  const siteHost = new URL(siteUrl).hostname;
  const runTimestamp = formatTimestamp(new Date());

  const collector = createArtifactDirs(runDir, browserName);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  const stepResults: StepResult[] = [];
  let finalStatus: BrowserResult["status"] = "pass";
  let errorSummary = "";
  const videoName = `${siteHost}-${runTimestamp}.webm`;

  // Popup state
  let popupPage: Page | null = null;
  let pendingPopup: Promise<Page> | null = null;

  const logStep = (label: string, type: string, status: string, err?: string, detail?: string) => {
    if (!options.verbose) return;
    const icon = status === "pass" ? "✓" : status === "skip" ? "○" : "✗";
    const action = detail ? `${type}: ${detail}` : type;
    const line = `  ${icon} ${label.padEnd(6)} ${action}`;
    if (err) console.log(`${line} — ${err}`);
    else console.log(line);
  };

  const stepDetail = (step: CompiledStep): string => {
    const { type, params } = step;
    switch (type) {
      case "goto": return params.url as string;
      case "click": return (params.selector as string).substring(0, 40);
      case "fill": return `${(params.selector as string).substring(0, 20)} ← ${String(params.value).substring(0, 20)}`;
      case "wait":
        if (params.selector) return (params.selector as string).substring(0, 30);
        if (params.ms) return `${params.ms}ms`;
        if (params.url) return (params.url as string).substring(0, 30);
        return "";
      case "screenshot": return params.name ? (params.name as string) : "";
      case "evaluate": return (params.script as string).substring(0, 30);
      case "db_query": return (params.query as string).substring(0, 40);
      case "request": return `${params.method} ${(params.url as string).substring(0, 30)}`;
      case "assert": case "assert_visible": case "assert_hidden":
        return (params.selector as string).substring(0, 30);
      case "assert_text": return (params.text as string).substring(0, 30);
      case "dialog_accept": return params.promptText ? `"${params.promptText}"` : "";
      case "dialog_dismiss": return "";
      case "popup": return "";
      case "popup_wait": return (params.url as string) || "";
      case "popup_close": return "";
      case "wait_for_network_idle": return "";
      case "wait_for_navigation": return (params.url as string) || "";
      case "wait_for_function": return (params.fn as string).substring(0, 30);
      case "select": return `${(params.selector as string).substring(0, 20)} → ${params.value}`;
      case "check": case "uncheck": return (params.selector as string).substring(0, 30);
      case "press": return (params.key as string);
      default: return "";
    }
  };

  try {
    // Parse resolution: shorthands (720p, 1080p, 2k, 4k) or custom (1920x1080)
    const resolution = parseResolution(options.resolution);
    const viewport = { width: resolution.width, height: resolution.height };

    const launchFn = browserName === "firefox" ? firefox : browserName === "webkit" ? webkit : chromium;

    // ── Persistent profile path ────────────────────────────────────
    if (options.profile) {
      const profilePath = resolve(options.profile);

      // Disable Chrome password leak detection in profile prefs
      await patchChromePrefs(profilePath);

      if (options.verbose) {
        console.log(`   📂 Using persistent profile: ${profilePath}`);
      }

      const persistentOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
        headless: !options.headed,
        viewport,
        // Anti-detection + disable annoying Chrome dialogs
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process,PasswordCheck,PasswordLeakDetection",
        ],
        // Realistic user agent
        userAgent: options.userAgent ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      };

      // Only chromium-based browsers support `channel`
      if (options.channel && browserName !== "firefox" && browserName !== "webkit") {
        (persistentOpts as Record<string, unknown>).channel = options.channel;
      }

      if (options.userAgent) {
        persistentOpts.userAgent = options.userAgent;
      }

      // recordVideo goes at top-level for persistent context
      persistentOpts.recordVideo = {
        dir: collector.videoDir,
        size: viewport,
      };
      persistentOpts.baseURL = siteUrl;
      try {
        context = await launchFn.launchPersistentContext(profilePath, persistentOpts);
      } catch (e: any) {
        const msg: string = e.message || "";
        if (msg.includes("Executable doesn't exist") || msg.includes("not found") || msg.includes("Please install")) {
          console.log(`   📦 Installing ${browserName}...`);
          const { execSync } = await import("child_process");
          execSync(`npx playwright install ${browserName}`, { stdio: "inherit" });
          context = await launchFn.launchPersistentContext(profilePath, persistentOpts);
        } else {
          // Detect specific profile errors and give helpful guidance
          if (msg.includes("Target page, context or browser has been closed")) {
            if (browserName !== "firefox" && browserName !== "webkit") {
              const defaultChromeDir = process.env.LOCALAPPDATA + "\\Google\\Chrome\\User Data";
              if (profilePath.toLowerCase() === defaultChromeDir.toLowerCase()) {
                throw new Error(
                  `Chrome blocks DevTools on the DEFAULT User Data directory.\n` +
                  `Fix: copy your profile to a non-default location:\n` +
                  `  robocopy "${defaultChromeDir}" "C:\\Users\\${process.env.USERNAME}\\batman-chrome-profile" /E /XD Crashpad Cache "Code Cache" GPUCache ShaderCache GrShaderCache\n` +
                  `Then use: --profile "C:\\Users\\${process.env.USERNAME}\\batman-chrome-profile"\n` +
                  `Or use --cdp-port to connect to running Chrome:\n` +
                  `  1. Launch Chrome: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222\n` +
                  `  2. Run: batman ... --cdp-port 9222`
                );
              }
            }
            throw new Error(
              `${msg}\n\nThis usually means:\n` +
              `- Chrome/Firefox is already running with this profile. Close all browser windows first.\n` +
              `- Or the profile is incompatible with Playwright's browser version.\n` +
              `Tip: use --cdp-port to connect to an already-running browser instead.`
            );
          }
          if (msg.includes("Profile is locked") || msg.includes("already in use")) {
            throw new Error(
              `Profile is locked by another process.\n` +
              `Close all ${browserName} windows, then try again.\n` +
              `Or use --cdp-port to connect to the running browser.`
            );
          }
          throw e;
        }
      }

      console.log(`   ✅ Persistent context ready (${context.pages().length} existing page(s) from session)`);

      // Close restored session pages but KEEP at least one
      const restoredPages = context.pages();
      if (restoredPages.length > 1) {
        for (let i = 0; i < restoredPages.length - 1; i++) {
          try { if (!restoredPages[i].isClosed()) await restoredPages[i].close(); } catch {}
        }
        if (options.verbose) console.log(`   🧹 Closed ${restoredPages.length - 1} restored page(s)`);
      }
      // Use the remaining page or create a new one
      page = restoredPages.length > 0 ? restoredPages[restoredPages.length - 1] : await context.newPage();

      // Anti-detection: hide webdriver flag
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        // @ts-ignore
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      });
      console.log(`   📄 Fresh automation page ready`);
    } else {
      // ── Clean temp profile path (existing behavior) ──────────────
      try {
        browser = await launchFn.launch({ headless: !options.headed });
      } catch (e) {
        const msg = (e as Error).message || "";
        if (msg.includes("Executable doesn't exist") || msg.includes("not found") || msg.includes("Please install")) {
          console.log(`   📦 Installing ${browserName}...`);
          const { execSync } = await import("child_process");
          execSync(`npx playwright install ${browserName}`, { stdio: "inherit" });
          browser = await launchFn.launch({ headless: !options.headed });
        } else {
          throw e;
        }
      }

      // Create context with video + baseURL + optional storage state
      const contextOptions: Parameters<Browser["newContext"]>[0] = {
        baseURL: siteUrl,
        viewport,
        recordVideo: {
          dir: collector.videoDir,
          size: viewport,
        },
      };
      // Download and other options follow
      if (options.userAgent) {
        contextOptions.userAgent = options.userAgent;
      }
      context = await browser.newContext(contextOptions);

      page = await context.newPage();
      console.log(`   ✅ Temp browser context ready`);
    }
    page.setDefaultTimeout(options.timeout);

    await setupArtifacts(context, page, collector);

    // Dialog handler
    page.on("dialog", async (dialog) => {
      if (acceptNextDialog) {
        acceptNextDialog = false;
        await dialog.accept(acceptDialogText);
        if (options.verbose) console.log(`   💬 Dialog accepted: ${dialog.message()}`);
        return;
      }
      // Unexpected dialog — auto-dismiss with warning
      await dialog.dismiss();
      if (options.verbose) {
        console.log(`   ⚠️  Unexpected dialog dismissed: ${dialog.message()}`);
      }
    });

    // Helper: handles popup lifecycle + delegates normal steps to executeStep
    const handleStep = async (step: CompiledStep): Promise<StepResult> => {
      if (step.type === "popup") {
        const start = Date.now();
        if (!page) throw new Error("popup: main page is closed");
        pendingPopup = page.waitForEvent("popup", { timeout: options.timeout });
        if (options.verbose) console.log(`   📋 Popup listener registered (timeout=${options.timeout}ms)`);
        return { index: step.index, type: step.type, status: "pass", durationMs: Date.now() - start };
      }

      if (step.type === "popup_wait") {
        const start = Date.now();
        if (!pendingPopup) throw new Error("popup_wait: no active popup listener. Add 'popup' step before the action that triggers the popup.");
        popupPage = await pendingPopup;
        await popupPage.waitForLoadState("domcontentloaded");
        pendingPopup = null;
        if (step.params.url) {
          await popupPage.waitForURL(step.params.url as string, { timeout: (step.params.timeout as number) || options.timeout });
        }
        if (options.verbose) console.log(`   📋 Popup captured: ${popupPage.url()}`);
        await setupArtifacts(context!, popupPage, collector);
        return { index: step.index, type: step.type, status: "pass", durationMs: Date.now() - start };
      }

      if (step.type === "popup_close") {
        const start = Date.now();
        if (popupPage) {
          await popupPage.close().catch(() => {});
          popupPage = null;
          if (options.verbose) console.log(`   📋 Popup closed, back to main page`);
        }
        pendingPopup = null;
        return { index: step.index, type: step.type, status: "pass", durationMs: Date.now() - start };
      }

      return await executeStep(
        // Use popup if valid, otherwise main page
        (popupPage && !popupPage.isClosed() ? popupPage : page!),
        step,
        collector,
        options,
        runtimeVars
      );
    };

    // Execute steps
    const topLevelSteps = steps.filter(s => !s.children).length;
    const branchCount = steps.filter(s => s.children).length;
    console.log(`\n▶ Starting execution: ${topLevelSteps} top-level step(s), ${branchCount} branch(es) — ${steps.length} total compiled`);
    
    for (const step of steps) {
      if (!page) break;

      // Handle child branching
      if (step.children) {
        // Child-level `when` — skip entire block if condition falsy
        if (step.condition && !isTruthy(step.condition, runtimeVars)) {
          console.log(`  ○ Child block skipped (${step.condition})`);
          continue;
        }

        const branchNames = Object.keys(step.children);
        const cacheKey = `branch:${scenarioPath}:${step.index}`;
        const preSelected = branchChoices.get(step.index);
        const labels = step.childLabels
          ? branchNames.map(n => step.childLabels![n] ?? n)
          : undefined;

        if (step.childType === "checkbox") {
          const selected = (preSelected as number[]) ?? await selectBranches(branchNames, step.index, cacheKey, labels, options.rememberLast);
          const selectedNames = selected.map(i => {
            const name = branchNames[i];
            const label = step.childLabels?.[name];
            return label ?? name;
          });
          console.log(`  → ${selectedNames.length > 0 ? selectedNames.join(", ") : "(none)"}`);

          // Save selection to variable if `var` is set
          if (step.varName) {
            runtimeVars.set(step.varName, selectedNames.join(","));
            console.log(`  📌 \${${step.varName}} = ${selectedNames.join(",")}`);
          }

          // If nothing selected and onEmpty is defined, run the fallback steps
          if (selected.length === 0 && step.onEmpty) {
            console.log(`  ═══ on_empty fallback ═══`);
            for (const subStep of step.onEmpty) {
              if (!page) break;
              const result = await handleStep(subStep);
              stepResults.push(result);
              console.log(`    ${result.status === "pass" ? "✓" : "✗"} ${subStep.label ?? String(subStep.index)}: ${subStep.type}${stepDetail(subStep) ? ` → ${stepDetail(subStep)}` : ""} (${result.durationMs}ms)${result.error ? ` — ${result.error}` : ""}`);
              logStep(subStep.label ?? String(subStep.index), subStep.type, result.status, result.error, stepDetail(subStep));
              if (result.status === "fail" || result.status === "error") {
                finalStatus = "fail";
                if (result.error) errorSummary += `Step ${subStep.index} (on_empty): ${result.error}\n`;
                if (subStep.on_fail === "stop") break;
              }
            }
            continue;
          }

          let shouldStopChildren = false;
          for (const idx of selected) {
            if (shouldStopChildren) break;
            const name = branchNames[idx];
            const label = step.childLabels?.[name] ?? name;
            console.log(`\n  ═══ ${label} ═══`);
            const subSteps = step.children[name];
            try {
              for (const subStep of subSteps) {
                if (!page) break;
                const result = await handleStep(subStep);
                stepResults.push(result);
                console.log(`    ${result.status === "pass" ? "✓" : result.status === "skip" ? "○" : "✗"} ${subStep.label ?? String(subStep.index)}: ${subStep.type}${stepDetail(subStep) ? ` → ${stepDetail(subStep)}` : ""} (${result.durationMs}ms)${result.error ? ` — ${result.error}` : ""}`);
                logStep(subStep.label ?? String(subStep.index), subStep.type, result.status, result.error, stepDetail(subStep));
                if (result.status === "fail" || result.status === "error") {
                  finalStatus = "fail";
                  if (result.error) errorSummary += `Step ${subStep.index} (${name}): ${result.error}\n`;
                  if (subStep.on_fail === "stop") {
                    shouldStopChildren = true;
                    break;
                  }
                }
              }
            } catch (e) {
              const msg = (e as Error).message || String(e);
              console.log(`  ✗ ${label} crashed: ${msg}`);
              finalStatus = "fail";
              errorSummary += `Step branch ${name}: ${msg}\n`;
              shouldStopChildren = true;
            }
            console.log(`  ═══ ${label} done ═══`);
          }
        } else {
          const selected = (preSelected as number) ?? await selectBranch(branchNames, step.index, cacheKey, labels, options.rememberLast);
          const selectedName = branchNames[selected];
          const displayName = step.childLabels?.[selectedName] ?? selectedName;
          console.log(`  → ${displayName}`);
          const subSteps = step.children[selectedName];

          for (const subStep of subSteps) {
            if (!page) break;
            const result = await handleStep(subStep);
            stepResults.push(result);
            console.log(`    ${result.status === "pass" ? "✓" : result.status === "skip" ? "○" : "✗"} ${subStep.label ?? String(subStep.index)}: ${subStep.type}${stepDetail(subStep) ? ` → ${stepDetail(subStep)}` : ""} (${result.durationMs}ms)${result.error ? ` — ${result.error}` : ""}`);
            logStep(subStep.label ?? String(subStep.index), subStep.type, result.status, result.error, stepDetail(subStep));
            if (result.status === "fail" || result.status === "error") {
              finalStatus = "fail";
              if (result.error) errorSummary += `Step ${subStep.index} (${selectedName}): ${result.error}\n`;
              if (subStep.on_fail === "stop") break;
            }
          }
        }
        continue;
      }

      // Skip step if condition is falsy
      if (step.condition) {
        if (!isTruthy(step.condition, runtimeVars)) {
          stepResults.push({
            index: step.index, type: step.type, status: "skip", durationMs: 0,
            error: `Condition not met: ${step.condition}`,
          });
          console.log(`  ○ Step ${step.label ?? step.index}: ${step.type} (skipped — ${step.condition})`);
          continue;
        }
      }

      const result = await handleStep(step);

      stepResults.push(result);
      console.log(`  ${result.status === "pass" ? "✓" : result.status === "skip" ? "○" : "✗"} Step ${step.label ?? String(step.index)}: ${step.type}${stepDetail(step) ? ` → ${stepDetail(step)}` : ""} (${result.durationMs}ms)${result.error ? ` — ${result.error}` : ""}`);
      logStep(step.label ?? String(step.index), step.type, result.status, result.error, stepDetail(step));

      if (result.status === "fail" || result.status === "error") {
        finalStatus = "fail";
        if (result.error) {
          errorSummary += `Step ${step.index}: ${result.error}\n`;
        }

        // Check if we should stop
        if (step.on_fail === "stop") {
          // Mark remaining steps as skipped
          for (const remaining of steps.slice(steps.indexOf(step) + 1)) {
            stepResults.push({
              index: remaining.index,
              type: remaining.type,
              status: "skip",
              durationMs: 0,
              error: "Skipped due to previous failure",
            });
          }
          break;
        }
      }
    }
  } catch (err) {
    finalStatus = "error";
    errorSummary = (err as Error).message;
    if (options.verbose) {
      console.error(`   ❌ Worker error: ${errorSummary}`);
    }
  } finally {
    if (popupPage) await popupPage.close().catch(() => {});
    if (page) await page.close().catch(() => {});
    // CDP: close our context but leave Chrome running
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    // Write logs + rename video after context close
    await finalizeArtifacts(collector, videoName);
  }

  const finishedAt = new Date().toISOString();
  const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  // Resolve video path
  const videoPath = join(collector.videoDir, videoName);

  return {
    browser: browserName,
    status: finalStatus,
    durationMs,
    startedAt,
    finishedAt,
    steps: stepResults,
    artifacts: {
      video: videoPath,
      trace: collector.tracePath,
      screenshots: collector.screenshots.map((s) => join(collector.screenshotDir, s)),
      console: join(collector.videoDir, "console.json"),
      network: join(collector.videoDir, "network.json"),
    },
    consoleEntries: collector.consoleEntries,
    networkEntries: collector.networkEntries,
    errorSummary: errorSummary || undefined,
  };
}

async function executeStep(
  page: Page,
  step: CompiledStep,
  collector: ArtifactCollector,
  options: RunOptions,
  runtimeVars: Map<string, unknown>
): Promise<StepResult> {
  const start = Date.now();

  const tryExecute = async (): Promise<StepResult> => {
    try {
      await runAction(page, step, collector, options, runtimeVars);
      return {
        index: step.index,
        type: step.type,
        status: "pass",
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const errorMsg = (err as Error).message;

      // Capture page context for debugging
      let pageContext = "";
      try {
        const pgUrl = page.url();
        const pgTitle = await page.title().catch(() => "?");
        pageContext = ` [url: ${pgUrl}, title: "${pgTitle}"]`;
      } catch {}

      // Auto-screenshot on failure
      let screenshotFilename = "";
      try {
        screenshotFilename = await takeScreenshot(
          page,
          collector,
          `${step.label ?? String(step.index)}-failure`,
          true
        );
      } catch {
        // Screenshot failed — continue
      }

      return {
        index: step.index,
        type: step.type,
        status: "fail",
        durationMs: Date.now() - start,
        error: errorMsg + pageContext,
        screenshot: screenshotFilename,
      };
    }
  };

  // First attempt
  let result = await tryExecute();

  // Retry on failure
  for (let retry = 0; retry < options.retries && result.status === "fail"; retry++) {
    if (options.verbose) {
      console.log(`   🔄 Retrying step ${step.index} (${retry + 1}/${options.retries})...`);
    }
    result = await tryExecute();
  }

  return result;
}

async function runAction(
  page: Page,
  step: CompiledStep,
  collector: ArtifactCollector,
  options: RunOptions,
  runtimeVars: Map<string, unknown>
): Promise<void> {
  const { type, params } = step;

  switch (type) {
    // ── Navigation ──
    case "goto":
      await page.goto(params.url as string, { waitUntil: "domcontentloaded" });
      break;

    // ── Interaction ──
    case "click": {
      const loc = page.locator(params.selector as string).first();
      const force = params.force as boolean | undefined;
      if (!force) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
      }
      await loc.click({ force });
      break;
    }
    case "fill": {
      const sel = params.selector as string;
      const val = params.value as string;
      const force = params.force as boolean | undefined;
      if (force) {
        // React controlled inputs: native setter + composed events
        await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
          const el = document.querySelector(sel) as HTMLInputElement | null;
          if (!el) throw new Error(`Element not found: ${sel}`);
          const nativeSetter = (Object as any).getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
          ).set;
          nativeSetter.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        }, { sel, val });
      } else {
        const loc = page.locator(sel).first();
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.fill(val);
      }
      break;
    }
    case "select":
      await page.locator(params.selector as string).first().selectOption(params.value as string);
      break;
    case "check":
      await page.locator(params.selector as string).first().check();
      break;
    case "uncheck":
      await page.locator(params.selector as string).first().uncheck();
      break;
    case "upload":
      await page.locator(params.selector as string).first().setInputFiles(params.files as string[]);
      break;
    case "press":
      await page.keyboard.press(params.key as string);
      break;
    case "drag": {
      const source = page.locator(params.source as string);
      const target = page.locator(params.target as string);
      await source.dragTo(target);
      break;
    }
    case "hover":
      await page.locator(params.selector as string).first().hover();
      break;
    case "wait": {
      if (params.ms) {
        await page.waitForTimeout(params.ms as number);
      } else if (params.selector) {
        await page.locator(params.selector as string).first().waitFor({ state: "visible", timeout: options.timeout });
      } else if (params.url) {
        await page.waitForURL(params.url as string, { timeout: options.timeout });
      }
      break;
    }
    case "screenshot": {
      const name = (params.name as string) || (step.label ?? String(step.index));
      await takeScreenshot(page, collector, name, (params.fullPage as boolean) ?? false);
      break;
    }
    case "evaluate": {
      if (params.args && Array.isArray(params.args)) {
        // Script is a function declaration like "(optionText) => { ... }"
        // new Function returns it, then page.evaluate calls it with args
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function(`return ${params.script}`)() as (...args: unknown[]) => unknown;
        await (page.evaluate as Function)(fn, ...(params.args as unknown[]));
      } else {
        await page.evaluate(params.script as string);
      }
      break;
    }

    // ── Dialogs ──
    case "dialog_accept":
      acceptNextDialog = true;
      acceptDialogText = params.promptText as string | undefined;
      break;
    case "dialog_dismiss":
      // Dialog dismiss is a no-op — unexpected dialogs auto-dismiss anyway
      break;

    // ── React / SPA ──
    case "wait_for_navigation":
      await page.waitForURL(
        (params.url as string) || "**",
        { timeout: options.timeout }
      );
      break;
    case "wait_for_network_idle":
      await page.waitForLoadState("networkidle", {
        timeout: (params.timeout as number) || options.timeout,
      });
      break;
    case "wait_for_function":
      await page.waitForFunction(params.fn as string, { timeout: options.timeout });
      break;

    // ── API Requests ──
    case "request": {
      const url = params.url as string;
      const method = (params.method as string) || "GET";
      const headers = (params.headers as Record<string, string>) || {};
      const body = params.body ? JSON.stringify(params.body) : undefined;

      const response = await fetch(url, { method, headers, body });

      let data: unknown;
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      if (params.save_as) {
        runtimeVars.set(params.save_as as string, data);
      }
      if (params.save_to) {
        const filename = params.save_to as string;
        const path = join(collector.screenshotDir, filename.endsWith(".json") ? filename : `${filename}.json`);
        const { writeFileSync: wfs2, mkdirSync: mds2 } = await import("fs");
        mds2(collector.screenshotDir, { recursive: true });
        wfs2(path, JSON.stringify(data, null, 2));
      }
      break;
    }

    // ── Database Queries ──
    case "db_query": {
      const engine = params.engine as string;
      const connection = params.connection as string;
      const query = params.query as string;

      try {
        let result: unknown;

        if (engine === "mysql") {
          result = await runMysqlQuery(connection, query);
        } else if (engine === "postgres") {
          result = await runPgQuery(connection, query);
        } else if (engine === "sqlite") {
          result = await runSqliteQuery(connection, query);
        } else {
          throw new Error(`Unknown db engine: ${engine}`);
        }

        if (params.save_as) {
          runtimeVars.set(params.save_as as string, result);
        }
        if (params.save_to) {
          const filename = params.save_to as string;
          const path = join(collector.screenshotDir, filename.endsWith(".json") ? filename : `${filename}.json`);
          const { writeFileSync: wfs, mkdirSync: mds } = await import("fs");
          mds(collector.screenshotDir, { recursive: true });
          wfs(path, JSON.stringify(result, null, 2));
        }
      } catch (e) {
        throw new Error(`db_query failed: ${(e as Error).message}`);
      }
      break;
    }

    // ── Assertions ──
    case "assert": {
      const result = await assertElement(page, params.selector as string, options.timeout);
      if (!result.passed) throw new Error(result.message);
      break;
    }
    case "assert_text": {
      const result = await assertText(page, params.text as string);
      if (!result.passed) throw new Error(result.message);
      break;
    }
    case "assert_url": {
      const result = assertUrl(page, params.url as string | RegExp);
      if (!result.passed) throw new Error(result.message);
      break;
    }
    case "assert_count": {
      const result = await assertCount(page, params.selector as string, params.count as number);
      if (!result.passed) throw new Error(result.message);
      break;
    }
    case "assert_visible": {
      const result = await assertVisible(page, params.selector as string);
      if (!result.passed) throw new Error(result.message);
      break;
    }
    case "assert_hidden": {
      const result = await assertHidden(page, params.selector as string);
      if (!result.passed) throw new Error(result.message);
      break;
    }
    case "assert_value": {
      const result = await assertValue(page, params.selector as string, params.value as string);
      if (!result.passed) throw new Error(result.message);
      break;
    }
    case "assert_no_console_error": {
      const result = assertNoConsoleError(collector.consoleEntries);
      if (!result.passed) throw new Error(result.message);
      break;
    }
    case "assert_no_failed_request": {
      const result = assertNoFailedRequest(collector.networkEntries);
      if (!result.passed) throw new Error(result.message);
      break;
    }
    case "assert_json": {
      const source = runtimeVars.get(params.source as string);
      const result = assertJson(
        source,
        params.path as string,
        params.equals,
        params.contains as string | undefined
      );
      if (!result.passed) throw new Error(result.message);
      break;
    }
    case "assert_db": {
      const source = runtimeVars.get(params.source as string);
      const result = assertDb(
        source,
        params.column as string | undefined,
        params.equals,
        params.exists as boolean | undefined
      );
      if (!result.passed) throw new Error(result.message);
      break;
    }

    // ── Debugging ──
    case "save_html": {
      const label = (params.label as string) || "page";
      const html = await page.content();
      const { writeFileSync, mkdirSync } = await import("fs");
      const { join } = await import("path");
      mkdirSync(collector.screenshotDir, { recursive: true });
      const filename = `${label.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 60)}.html`;
      writeFileSync(join(collector.screenshotDir, filename), html);
      if (options.verbose) console.log(`   💾 Saved HTML: ${filename}`);
      break;
    }

    default:
      throw new Error(`Unknown action: ${type}`);
  }
}

// ─── Database Helpers ──────────────────────────────────────

interface MysqlUri {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}

function parseMysqlUri(uri: string): MysqlUri {
  // mysql://user:pass@host:port/db
  // mysql://user:pass@host/db
  const url = new URL(uri);
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: url.port ? parseInt(url.port) : 3306,
    database: url.pathname.replace(/^\//, ""),
  };
}

async function runMysqlQuery(connectionStr: string, query: string): Promise<unknown> {
  try {
    const mysql2 = await import("mysql2/promise");
    const cfg = parseMysqlUri(connectionStr);
    const conn = await mysql2.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
    });
    const [rows] = await conn.execute(query);
    await conn.end();
    // For SELECT, return rows. For INSERT/UPDATE/DELETE, return affectedRows info
    if (Array.isArray(rows)) {
      return rows.length === 1 ? rows[0] : rows;
    }
    return rows;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" || String(e).includes("Cannot find module")) {
      throw new Error("mysql2 not installed. Run: npm install mysql2");
    }
    throw e;
  }
}

async function runPgQuery(_connection: string, _query: string): Promise<unknown> {
  throw new Error("PostgreSQL not yet supported. Install pg: npm install pg");
}

async function runSqliteQuery(_connection: string, _query: string): Promise<unknown> {
  throw new Error("SQLite not yet supported. Install better-sqlite3: npm install better-sqlite3");
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function resolveUrl(url: string, siteUrl: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) {
    const base = new URL(siteUrl);
    return `${base.protocol}//${base.host}${url}`;
  }
  return `${siteUrl.replace(/\/$/, "")}/${url}`;
}

function isTruthy(val: string | undefined, runtimeVars?: Map<string, unknown>): boolean {
  if (!val) return true;
  let v = val.trim();

  // Resolve $var references from runtimeVars (e.g., $destinations → actual value)
  if (runtimeVars) {
    v = v.replace(/\$(\w[\w-]*)/g, (_, name) => String(runtimeVars.get(name) ?? ""));
  }

  // Handle {{var}} that survived resolution (empty/not found)
  v = v.replace(/\{\{.+?\}\}/g, "").trim();
  if (!v) return true; // empty after stripping unresolved vars → always run

  // Expression: "value == literal" or "value != literal"
  const eqMatch = v.match(/^(.+?)\s*==\s*(.+)$/);
  if (eqMatch) return eqMatch[1].trim().toLowerCase() === eqMatch[2].trim().toLowerCase();

  const neqMatch = v.match(/^(.+?)\s*!=\s*(.+)$/);
  if (neqMatch) return neqMatch[1].trim().toLowerCase() !== neqMatch[2].trim().toLowerCase();

  // Expression: "value in [a, b, c]" or "!value in [a, b, c]"
  const inMatch = v.match(/^(!?)\s*(.+?)\s+in\s+\[(.+)\]$/);
  if (inMatch) {
    const negate = inMatch[1] === "!";
    const needle = inMatch[2].trim().toLowerCase();
    // CSV-aware: split needle by comma, check if ANY token matches
    const needles = needle.split(",").map(s => s.trim()).filter(Boolean);
    const haystack = inMatch[3].split(",").map(s => s.trim().toLowerCase());
    const found = needles.length > 0 && needles.some(n => haystack.includes(n));
    return negate ? !found : found;
  }

  // Simple truthy/falsy (with optional ! prefix)
  let check = v.toLowerCase();
  let negate = false;
  if (check.startsWith("!")) { negate = true; check = check.substring(1).trim(); }
  const result = check === "true" || check === "yes" || check === "1" || check === "on";
  return negate ? !result : result;
}

function parseResolution(input?: string): { width: number; height: number } {
  if (!input) return { width: 1280, height: 720 };
  const v = input.toLowerCase().trim();

  // Shorthands
  const presets: Record<string, [number, number]> = {
    "480p": [854, 480], "sd": [854, 480],
    "720p": [1280, 720], "hd": [1280, 720],
    "900p": [1600, 900], "hd+": [1600, 900],
    "1080p": [1920, 1080], "fhd": [1920, 1080], "fullhd": [1920, 1080],
    "1440p": [2560, 1440], "2k": [2560, 1440], "qhd": [2560, 1440],
    "2160p": [3840, 2160], "4k": [3840, 2160], "uhd": [3840, 2160],
  };
  if (presets[v]) {
    const [w, h] = presets[v];
    return { width: w, height: h };
  }

  // Custom WxH
  const parts = v.split("x");
  if (parts.length === 2) {
    const w = parseInt(parts[0], 10);
    const h = parseInt(parts[1], 10);
    if (w > 0 && h > 0) return { width: w, height: h };
  }

  return { width: 1280, height: 720 };
}

async function patchChromePrefs(profileDir: string): Promise<void> {
  // Disable "Change your password" and password leak detection
  const prefsPath = join(profileDir, "Default", "Preferences");
  try {
    // Dynamic import for ESM compatibility
    const fs = await import("fs");
    if (!fs.existsSync(prefsPath)) return;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    if (!prefs.credentials) prefs.credentials = {};
    prefs.credentials.password_leak_detection = false;
    if (!prefs.profile) prefs.profile = {};
    prefs.profile.password_manager_leak_detection = false;
    prefs.profile.exit_type = "Normal";
    prefs.profile.exited_cleanly = true;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
  } catch { /* ignore */ }
}
