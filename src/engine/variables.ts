import type { ParsedScenario, ScenarioStep } from "../types.js";
import { randomBytes } from "crypto";
import { createInterface } from "readline";
import { stdin, stdout } from "process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Env File Loader ─────────────────────────────────────────

export function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    console.error(`⚠️  Env file not found: ${filePath}`);
    return;
  }
  const content = readFileSync(filePath, "utf-8");
  let count = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    count++;
  }
  console.log(`📄 Loaded ${count} variables from ${filePath}`);
}

// ─── Cache ───────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), ".batman");
const CACHE_FILE = join(CACHE_DIR, "cache.json");

function loadCache(): Record<string, string> {
  try {
    if (existsSync(CACHE_FILE)) {
      return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveCache(cache: Record<string, string>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

export function clearCache(): void {
  try {
    if (existsSync(CACHE_FILE)) {
      writeFileSync(CACHE_FILE, "{}");
      console.log("✅ Variable cache cleared.");
    }
  } catch {}
}

// Yes/No Prompt (arrow key selector)

function promptYesNo(label: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  let selected = defaultYes;

  return new Promise((resolve) => {
    const rawMode = stdin.isTTY;
    if (rawMode) stdin.setRawMode(true);
    stdin.resume();

    function render() {
      stdout.write("\r\x1b[K"); // clear current line
      const yesMarker = selected ? "●" : "○";
      const noMarker = !selected ? "●" : "○";
      stdout.write(`   ${label}   ${yesMarker} Yes   ${noMarker} No`);
    }

    render();

    stdin.on("data", (key: Buffer) => {
      const byte = key[0];
      if (byte === 13) {
        // Enter
        cleanup();
        resolve(selected);
      } else if (byte === 27 && key[1] === 91) {
        // Arrow key
        const code = key[2];
        if (code === 67 || code === 68) {
          // Right (67) or Left (68) — toggle
          selected = !selected;
          render();
        }
      } else if (byte === 3) {
        // Ctrl+C
        cleanup();
        resolve(defaultYes);
      } else {
        // Any other key — treat as toggle or Y/N
        const char = String(key).toLowerCase().trim();
        if (char === "y") { selected = true; render(); }
        else if (char === "n") { selected = false; render(); }
      }
    });

    function cleanup() {
      if (rawMode) stdin.setRawMode(false);
      stdin.pause();
      rl.close();
      stdout.write("\n");
    }
  });
}

// Prompt (text input)

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Dynamic Variable Generators

const generators: Record<string, () => string> = {
  random_email: () => `test_${randomId(8)}@batman.test`,
  random_string: () => randomId(8),
  random_number: () => String(Math.floor(Math.random() * 100000)),
  timestamp: () => String(Math.floor(Date.now() / 1000)),
  uuid: () => crypto.randomUUID(),
  date: () => new Date().toISOString().slice(0, 10),
  time: () => new Date().toISOString().slice(11, 19),
};

function randomId(len: number): string {
  return randomBytes(Math.ceil(len / 2))
    .toString("hex")
    .slice(0, len);
}

// ─── Resolver ───────────────────────────────────────────────

export async function resolveVariables(
  scenario: ParsedScenario,
  clearCacheFlag = false,
  rememberLast = false
): Promise<ParsedScenario> {
  const scopeVars: Record<string, string> = { ...scenario.variables };
  const memoryCache: Record<string, string> = clearCacheFlag ? {} : loadCache();
  const pendingPrompts: Promise<void>[] = [];
  const promptResults: Record<string, string> = {};

  // Collect unresolved vars AND always-prompt vars
  const unresolvedEnvVars = new Set<string>();
  const alwaysPromptVars = new Set<string>();

  function collectUnresolved(value: unknown): void {
    if (typeof value === "string") {
      const matches = value.matchAll(/\{\{(.+?)\}\}/g);
      for (const [, key] of matches) {
        const trimmed = key.trim();

        // ? prefix — always prompt
        if (trimmed.startsWith("?")) {
          const rest = trimmed.slice(1);
          // Extract var name from ternary: ?var ? ... : ...
          const ternaryMatch = rest.match(/^(.+?)\s*\?\s*.+?\s*:\s*.+$/);
          const varName = ternaryMatch ? ternaryMatch[1].trim() : rest;
          alwaysPromptVars.add(varName);
          continue;
        }

        // env: prefix
        if (trimmed.startsWith("env:")) {
          const envVar = trimmed.slice(4);
          if (process.env[envVar] === undefined && memoryCache[envVar] === undefined) {
            unresolvedEnvVars.add(envVar);
          }
          continue;
        }

        // Bare var — not a generator, not in scopeVars, not in env
        if (!generators[trimmed] && scopeVars[trimmed] === undefined) {
          // Skip random ranges
          if (trimmed.match(/^random:\d+-\d+$/)) continue;
          if (process.env[trimmed] === undefined && memoryCache[trimmed] === undefined) {
            unresolvedEnvVars.add(trimmed);
          }
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) collectUnresolved(item);
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) {
        collectUnresolved(v);
      }
    }
  }

  // Scan scenario for unresolved env vars
  if (scenario.variables) {
    for (const v of Object.values(scenario.variables)) collectUnresolved(v);
  }
  for (const step of scenario.steps) {
    const key = Object.keys(step)[0];
    collectUnresolved(step[key as keyof ScenarioStep]);
  }

  // Prompt user for each unresolved env var
  if (unresolvedEnvVars.size > 0 || alwaysPromptVars.size > 0) {
    console.log("\n📋 Some variables need your input:\n");

    // Unresolved env vars (prompt only if not cached)
    for (const envVar of unresolvedEnvVars) {
      if (memoryCache[envVar] !== undefined) {
        promptResults[envVar] = memoryCache[envVar];
        console.log(`   ${envVar}: ${"*".repeat(memoryCache[envVar].length)} (cached)`);
        continue;
      }
      const answer = await prompt(`   ${envVar}: `);
      promptResults[envVar] = answer;
      memoryCache[envVar] = answer;
    }

    // Always-prompt vars (? prefix) — yes/no selector
    for (const varName of alwaysPromptVars) {
      const cached = memoryCache[varName] || "";
      if (!stdin.isTTY || rememberLast) {
        const val = cached || "no";
        promptResults[varName] = val;
        console.log(`   ${varName}: ${val} ${cached ? "(cached)" : "(auto)"}`);
        continue;
      }
      // Yes/No — default to cached if available
      const defaultYes = cached === "true" || cached === "yes";
      const selected = await promptYesNo(varName, defaultYes);
      const val = selected ? "true" : "false";
      promptResults[varName] = val;
      memoryCache[varName] = val;
      console.log(`   ${varName}: ${selected ? "yes" : "no"}`);
    }

    // Save to disk cache
    saveCache(memoryCache);
    console.log();
  }

  // ─── Resolve ───

  const resolveValue = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      return value.replace(/\{\{(.+?)\}\}/g, (_, key: string) => {
        const trimmed = key.trim();

        // ? prefix — always-prompted var, optional ternary
        if (trimmed.startsWith("?")) {
          const rest = trimmed.slice(1);
          // Check for ternary: ?var ? true_val : false_val
          const ternaryMatch = rest.match(/^(.+?)\s*\?\s*(.+?)\s*:\s*(.+)$/);
          if (ternaryMatch) {
            const varName = ternaryMatch[1].trim();
            const trueVal = ternaryMatch[2].trim();
            const falseVal = ternaryMatch[3].trim();
            const resolved = promptResults[varName] ?? memoryCache[varName] ?? "";
            const isTrue = resolved === "true" || resolved === "yes" || resolved === "1";
            return isTrue ? trueVal : falseVal;
          }
          // Plain ?var
          const varName = rest;
          if (promptResults[varName] !== undefined) return promptResults[varName];
          if (memoryCache[varName] !== undefined) return memoryCache[varName];
          return "";
        }

        // 1. Environment variable: {{env:VAR_NAME}}
        if (trimmed.startsWith("env:")) {
          const envVar = trimmed.slice(4);

          // Check process.env first
          const envVal = process.env[envVar];
          if (envVal !== undefined) return envVal;

          // Check prompted / cached values
          if (promptResults[envVar] !== undefined) return promptResults[envVar];
          if (memoryCache[envVar] !== undefined) return memoryCache[envVar];

          throw new Error(
            `Unresolved environment variable "$${envVar}" (use: {{env:${envVar}}})`
          );
        }

        // 2. Built-in generator: {{random_email}}, {{uuid}}, etc.
        if (generators[trimmed]) {
          return generators[trimmed]();
        }

        // 2b. Random range: {{random:1-10}}
        const rangeMatch = trimmed.match(/^random:(\d+)-(\d+)$/);
        if (rangeMatch) {
          const min = parseInt(rangeMatch[1], 10);
          const max = parseInt(rangeMatch[2], 10);
          return String(Math.floor(Math.random() * (max - min + 1)) + min);
        }

        // 3. Scenario-scoped variable: {{username}}
        if (scopeVars[trimmed] !== undefined) {
          return scopeVars[trimmed];
        }

        // 4. Bare var — try env/cache/prompt (same as {{env:...}})
        {
          const envVal = process.env[trimmed];
          if (envVal !== undefined) return envVal;
          if (promptResults[trimmed] !== undefined) return promptResults[trimmed];
          if (memoryCache[trimmed] !== undefined) return memoryCache[trimmed];
        }

        throw new Error(
          `Unresolved variable "{{${trimmed}}}" in "${path}". ` +
            `Available: ${Object.keys(scopeVars).join(", ") || "none"}, ` +
            `built-ins: ${Object.keys(generators).join(", ")}`
        );
      });
    }
    return value;
  };

  const resolveStep = (step: ScenarioStep, index: number): ScenarioStep => {
    const keys = Object.keys(step);
    // Find the action key (skip metadata)
    const metaKeys = new Set(["when", "if"]);
    const actionKey = keys.find(k => !metaKeys.has(k)) || keys[0];
    const val = step[actionKey as keyof ScenarioStep];

    if (actionKey === "child" && val && typeof val === "object") {
      // Recursively resolve each branch's sub-steps
      const childObj = val as Record<string, unknown>;
      const resolved: Record<string, unknown> = {};
      for (const [entryName, entryVal] of Object.entries(childObj)) {
        if (entryName === "type" || entryName === "when" || entryName === "on_empty") {
          resolved[entryName] = entryVal;
        } else if (Array.isArray(entryVal)) {
          resolved[entryName] = (entryVal as unknown[]).map((s, si) => {
            if (typeof s === "string") return s;
            return resolveStep(s as ScenarioStep, si);
          });
        } else {
          resolved[entryName] = entryVal;
        }
      }
      // Preserve `when` from parent step on child
      if (step.when) resolved.when = step.when;
      return { child: resolved, when: step.when } as ScenarioStep;
    }

    // Copy ALL keys, resolving only the action's value
    const resolved: ScenarioStep = {};
    for (const k of keys) {
      if (metaKeys.has(k)) {
        // Resolve variables in when/if condition strings
        const raw = step[k as keyof ScenarioStep];
        (resolved as any)[k] = typeof raw === "string"
          ? resolveValue(raw, `steps[${index}].${k}`)
          : raw;
      } else if (k === actionKey && val && typeof val === "object") {
        (resolved as any)[k] = deepResolve(
          val as Record<string, unknown>,
          `steps[${index}].${k}`
        );
      } else {
        (resolved as any)[k] = val;
      }
    }

    return resolved;
  };

  function deepResolve(obj: Record<string, unknown>, path: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        result[k] = resolveValue(v, `${path}.${k}`);
      } else if (Array.isArray(v)) {
        result[k] = v.map((item, i) => {
          if (typeof item === "string") {
            return resolveValue(item, `${path}.${k}[${i}]`);
          } else if (item && typeof item === "object" && !Array.isArray(item)) {
            return deepResolve(item as Record<string, unknown>, `${path}.${k}[${i}]`);
          }
          return item;
        });
      } else if (v && typeof v === "object") {
        result[k] = deepResolve(v as Record<string, unknown>, `${path}.${k}`);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  // Resolve variables block values first
  if (scenario.variables) {
    for (const [k, v] of Object.entries(scenario.variables)) {
      scopeVars[k] = resolveValue(v, `variables.${k}`) as string;
    }
  }

  const resolvedSteps = scenario.steps.map((step, i) => resolveStep(step, i));

  return {
    ...scenario,
    variables: scopeVars,
    steps: resolvedSteps,
  };
}
