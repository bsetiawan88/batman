import type { Page } from "playwright";
import type { ConsoleEntry, NetworkEntry } from "../types.js";

interface AssertResult {
  passed: boolean;
  message: string;
}

export function assertElement(
  page: Page,
  selector: string,
  timeout: number = 10000
): Promise<AssertResult> {
  return runAssert(async () => {
    await page.locator(selector).first().waitFor({ state: "visible", timeout });
    return { passed: true, message: `Element "${selector}" found` };
  }, `Element "${selector}" not found within ${timeout}ms`);
}

export function assertText(page: Page, text: string): Promise<AssertResult> {
  return runAssert(async () => {
    await page.getByText(text).first().waitFor({ state: "visible", timeout: 10000 });
    return { passed: true, message: `Text "${text}" found on page` };
  }, `Text "${text}" not found on page}`);
}

export function assertUrl(
  page: Page,
  urlPattern: string | RegExp
): AssertResult {
  const currentUrl = page.url();
  if (typeof urlPattern === "string") {
    const passed = currentUrl.includes(urlPattern);
    return {
      passed,
      message: passed
        ? `URL matches "${urlPattern}"`
        : `URL "${currentUrl}" does not contain "${urlPattern}"`,
    };
  }
  const passed = urlPattern.test(currentUrl);
  return {
    passed,
    message: passed
      ? `URL matches ${urlPattern}`
      : `URL "${currentUrl}" does not match ${urlPattern}`,
  };
}

export async function assertCount(
  page: Page,
  selector: string,
  expected: number
): Promise<AssertResult> {
  const count = await page.locator(selector).count();
  const passed = count === expected;
  return {
    passed,
    message: passed
      ? `Found ${count} elements matching "${selector}"`
      : `Expected ${expected} elements matching "${selector}", found ${count}`,
  };
}

export async function assertVisible(
  page: Page,
  selector: string
): Promise<AssertResult> {
  return runAssert(async () => {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 10000 });
    return { passed: true, message: `Element "${selector}" is visible` };
  }, `Element "${selector}" is not visible`);
}

export async function assertHidden(
  page: Page,
  selector: string
): Promise<AssertResult> {
  return runAssert(async () => {
    await page.locator(selector).first().waitFor({ state: "hidden", timeout: 10000 });
    return { passed: true, message: `Element "${selector}" is hidden` };
  }, `Element "${selector}" is still visible`);
}

export async function assertValue(
  page: Page,
  selector: string,
  expected: string
): Promise<AssertResult> {
  const value = await page.locator(selector).inputValue();
  const passed = value === expected;
  return {
    passed,
    message: passed
      ? `Input "${selector}" has value "${expected}"`
      : `Input "${selector}" has value "${value}", expected "${expected}"`,
  };
}

export function assertNoConsoleError(
  consoleEntries: ConsoleEntry[]
): AssertResult {
  const errors = consoleEntries.filter((e) => e.type === "error");
  const passed = errors.length === 0;
  return {
    passed,
    message: passed
      ? "No console errors"
      : `${errors.length} console error(s): ${errors.map((e) => e.message).join("; ")}`,
  };
}

export function assertNoFailedRequest(
  networkEntries: NetworkEntry[]
): AssertResult {
  const failures = networkEntries.filter((e) => e.isFailure);
  const passed = failures.length === 0;
  return {
    passed,
    message: passed
      ? "No failed network requests"
      : `${failures.length} failed request(s): ${failures.map((f) => `${f.url} (${f.status})`).join("; ")}`,
  };
}

export function assertJson(
  source: unknown,
  path: string,
  equals?: unknown,
  contains?: string
): AssertResult {
  const value = getJsonPath(source, path);
  if (value === undefined) {
    return { passed: false, message: `JSON path "${path}" not found in response` };
  }

  if (equals !== undefined) {
    const passed = deepEquals(value, equals);
    return {
      passed,
      message: passed
        ? `JSON path "${path}" equals expected value`
        : `JSON path "${path}" = ${JSON.stringify(value)}, expected ${JSON.stringify(equals)}`,
    };
  }

  if (contains !== undefined) {
    const str = String(value);
    const passed = str.includes(contains);
    return {
      passed,
      message: passed
        ? `JSON path "${path}" contains "${contains}"`
        : `JSON path "${path}" does not contain "${contains}"`,
    };
  }

  return { passed: true, message: `JSON path "${path}" = ${JSON.stringify(value)}` };
}

export function assertDb(
  result: unknown,
  column?: string,
  equals?: unknown,
  exists?: boolean
): AssertResult {
  const value = column ? getJsonPath(result, column) : result;

  if (exists !== undefined) {
    const hasRows = Array.isArray(result) ? result.length > 0 : result !== null && result !== undefined;
    const passed = exists ? hasRows : !hasRows;
    return {
      passed,
      message: passed
        ? exists
          ? "Database record exists"
          : "Database record does not exist"
        : exists
          ? "Database record not found"
          : "Database record still exists",
    };
  }

  if (equals !== undefined) {
    const passed = deepEquals(value, equals);
    return {
      passed,
      message: passed
        ? `Database value equals ${JSON.stringify(equals)}`
        : `Database value = ${JSON.stringify(value)}, expected ${JSON.stringify(equals)}`,
    };
  }

  return { passed: true, message: "Database value present" };
}

// ─── Helpers ───────────────────────────────────────────────

async function runAssert(
  fn: () => Promise<{ passed: boolean; message: string }>,
  errorMsg: string
): Promise<AssertResult> {
  try {
    return await fn();
  } catch {
    return { passed: false, message: errorMsg };
  }
}

function getJsonPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      if (isNaN(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === "object") {
      // Support bracket notation: data[0].name
      const bracketMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (bracketMatch) {
        current = (current as Record<string, unknown>)[bracketMatch[1]];
        if (Array.isArray(current)) {
          current = current[parseInt(bracketMatch[2], 10)];
        }
      } else {
        current = (current as Record<string, unknown>)[part];
      }
    } else {
      return undefined;
    }
  }
  return current;
}

function deepEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
