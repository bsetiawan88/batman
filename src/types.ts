// ─── Scenario Types ──────────────────────────────────────────

export interface ScenarioStep {
  when?: string;  // condition variable, skip step if falsy
  // Navigation
  goto?: { url: string };
  // Interaction
  click?: { selector: string; force?: boolean };
  fill?: { selector: string; value: string };
  select?: { selector: string; value: string };
  check?: { selector: string };
  uncheck?: { selector: string };
  upload?: { selector: string; files: string[] };
  press?: { key: string };
  drag?: { source: string; target: string };
  wait?: { ms?: number; selector?: string; url?: string };
  hover?: { selector: string };
  screenshot?: { name?: string; fullPage?: boolean };
  evaluate?: { script: string; args?: unknown[] };
  // Popups & Dialogs
  dialog_accept?: { promptText?: string };
  dialog_dismiss?: Record<string, never>;
  popup?: Record<string, never>;
  popup_wait?: { url?: string; timeout?: number };
  popup_close?: Record<string, never>;
  // React / SPA helpers
  wait_for_navigation?: { url?: string };
  wait_for_network_idle?: { timeout?: number };
  wait_for_function?: { fn: string };
  // Database & API verification
  request?: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    save_as?: string;
  };
  db_query?: {
    engine: "sqlite" | "postgres" | "mysql";
    connection: string;
    query: string;
    save_as?: string;
  };
  // Assertions
  assert?: { selector: string; timeout?: number };
  assert_text?: { text: string };
  assert_url?: { url: string | RegExp };
  assert_count?: { selector: string; count: number };
  assert_no_console_error?: Record<string, never>;
  assert_no_failed_request?: Record<string, never>;
  assert_visible?: { selector: string };
  assert_hidden?: { selector: string };
  assert_value?: { selector: string; value: string };
  assert_json?: {
    source: string;
    path: string;
    equals?: unknown;
    contains?: string;
  };
  assert_db?: {
    source: string;
    column?: string;
    equals?: unknown;
    exists?: boolean;
  };
  // Branching
  child?: Record<string, ScenarioStep[]>;
}

export interface ParsedScenario {
  name: string;
  description?: string;
  env_file?: string | string[];
  stop_on_failure?: boolean;
  variables?: Record<string, string>;
  steps: ScenarioStep[];
}

// ─── Compiled Types ─────────────────────────────────────────

export interface CompiledStep {
  index: number;
  type: string;
  params: Record<string, unknown>;
  rawLine: number;
  condition?: string; // when expression, skip if falsy
  on_fail?: "stop" | "continue";
  children?: Record<string, CompiledStep[]>;
  childType?: "radio" | "checkbox";
  childLabels?: Record<string, string>;
  onEmpty?: CompiledStep[];
  varName?: string;  // save checkbox selection to this variable
  label?: string;
}

// ─── Execution Types ────────────────────────────────────────

export interface StepResult {
  index: number;
  type: string;
  status: "pass" | "fail" | "skip" | "error";
  durationMs: number;
  error?: string;
  screenshot?: string;
}

export interface ConsoleEntry {
  type: "log" | "warn" | "error" | "info" | "debug";
  message: string;
  source?: string;
  lineNumber?: number;
  timestamp: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  statusText: string;
  durationMs: number;
  isFailure: boolean;
  failureReason?: string;
  timestamp: string;
}

export interface BrowserResult {
  browser: string;
  status: "pass" | "fail" | "error";
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  steps: StepResult[];
  artifacts: {
    video: string;
    trace: string;
    screenshots: string[];
    console: string;
    network: string;
  };
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  errorSummary?: string;
}

export interface SiteResult {
  url: string;
  status: "pass" | "fail" | "error";
  durationMs: number;
  browsers: BrowserResult[];
  summary: { passed: number; failed: number; total: number };
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scenario: string;
  scenarioName: string;
  sites: SiteResult[];
  totals: { sites: number; browsers: number; steps: number; passed: number; failed: number };
}

// ─── CLI Types ──────────────────────────────────────────────

export interface RunOptions {
  scenario: string;
  urls: string[];
  browsers: string[];
  mode: "sequential" | "parallel";
  outputDir: string;
  timeout: number;
  headed: boolean;
  verbose: boolean;
  dryRun: boolean;
  retries: number;
  maxWorkers: number;
  clearCache: boolean;
  envFile?: string;
  rememberLast?: boolean;
  userAgent?: string;
  profile?: string;
  channel?: string;
  resolution?: string;
}

export const VALID_BROWSERS = ["chromium", "firefox", "webkit"] as const;
export type BrowserName = (typeof VALID_BROWSERS)[number];
