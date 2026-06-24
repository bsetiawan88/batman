import { readFileSync } from "fs";
import { load } from "js-yaml";
import type { ParsedScenario, ScenarioStep } from "../types.js";

const VALID_ACTIONS = new Set([
  "goto",
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "upload",
  "press",
  "drag",
  "wait",
  "hover",
  "screenshot",
  "evaluate",
  "dialog_accept",
  "dialog_dismiss",
  "popup",
  "popup_wait",
  "popup_close",
  "wait_for_navigation",
  "wait_for_network_idle",
  "wait_for_function",
  "request",
  "db_query",
  "assert",
  "assert_text",
  "assert_url",
  "assert_count",
  "assert_no_console_error",
  "assert_no_failed_request",
  "assert_visible",
  "assert_hidden",
  "assert_value",
  "assert_json",
  "assert_db",
  "save_html",
  "child",
  "when",   // conditional: skip step if variable is falsy
  "if",     // conditional branch (future)
  "var",    // save child checkbox selection to variable
]);

export function parseScenario(filePath: string): ParsedScenario {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Cannot read scenario file: ${filePath}`);
  }

  let doc: unknown;
  try {
    doc = load(raw);
  } catch (e) {
    throw new Error(`Invalid YAML in ${filePath}: ${(e as Error).message}`);
  }

  if (!doc || typeof doc !== "object") {
    throw new Error(`Scenario file must contain a YAML object`);
  }

  const data = doc as Record<string, unknown>;

  if (typeof data.name !== "string" || !data.name.trim()) {
    throw new Error(`Scenario must have a non-empty "name" field`);
  }

  if (!Array.isArray(data.steps)) {
    throw new Error(`Scenario "${data.name}" must have a "steps" array`);
  }

  if (data.steps.length === 0) {
    throw new Error(`Scenario "${data.name}" must have at least one step`);
  }

  // Parse env_file
  let envFile: string | string[] | undefined;
  if (data.env_file !== undefined) {
    if (typeof data.env_file === "string") {
      envFile = data.env_file;
    } else if (Array.isArray(data.env_file)) {
      envFile = data.env_file.map(String);
    } else {
      throw new Error(`"env_file" must be a string or list of strings`);
    }
  }

  // Parse stop_on_failure
  const stopOnFailure = data.stop_on_failure === true;

  // Validate variables
  let variables: Record<string, string> | undefined;
  if (data.variables !== undefined) {
    if (typeof data.variables !== "object" || data.variables === null) {
      throw new Error(`"variables" must be an object of key-value pairs`);
    }
    variables = {};
    for (const [key, value] of Object.entries(data.variables as Record<string, unknown>)) {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`Variable "${key}" must be a string or number`);
      }
      variables[key] = String(value);
    }
  }

  // Validate steps
  const steps: ScenarioStep[] = [];
  let lineOffset = raw.indexOf("steps:") + 6;
  const lines = raw.split("\n");

  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];

    if (!step || typeof step !== "object") {
      throw new Error(`Step ${i + 1} must be an object`);
    }

    const keys = Object.keys(step as object);
    if (keys.length === 0) {
      throw new Error(`Step ${i + 1} is empty — must have an action`);
    }

    // Action key is the first non-metadata key (skip "when", "if")
    const metaKeys = new Set(["when", "if"]);
    const actionKey = keys.find(k => !metaKeys.has(k)) || keys[0];
    if (!VALID_ACTIONS.has(actionKey)) {
      throw new Error(
        `Step ${i + 1}: unknown action "${actionKey}". Valid: ${[...VALID_ACTIONS].join(", ")}`
      );
    }

    // Validate child branches
    if (actionKey === "child") {
      const childObj = step[actionKey as keyof typeof step] as Record<string, unknown>;
      if (!childObj || typeof childObj !== "object" || Array.isArray(childObj)) {
        throw new Error(`Step ${i + 1}: "child" must be an object of named branches`);
      }

      // Check for explicit type
      const childType = childObj.type as string | undefined;
      if (childType && childType !== "radio" && childType !== "checkbox") {
        throw new Error(`Step ${i + 1}: child type must be "radio" or "checkbox", got "${childType}"`);
      }

      // Branches are all keys except "type", "when", "on_empty", "var"
      const branchNames = Object.keys(childObj).filter(k => k !== "type" && k !== "when" && k !== "on_empty" && k !== "var");
      if (branchNames.length === 0) {
        throw new Error(`Step ${i + 1}: "child" must have at least one branch`);
      }
      for (const name of branchNames) {
        const substeps = childObj[name];
        if (!Array.isArray(substeps) || substeps.length === 0) {
          throw new Error(`Step ${i + 1}: branch "${name}" must have at least one step`);
        }

        // Skip first element if it's a string (branch label)
        let startIdx = 0;
        if (typeof substeps[0] === "string") {
          startIdx = 1;
          if (substeps.length === 1) {
            throw new Error(`Step ${i + 1}: branch "${name}" has a label but no steps`);
          }
        }

        for (let si = startIdx; si < substeps.length; si++) {
          const sub = substeps[si];
          if (!sub || typeof sub !== "object") {
            throw new Error(`Step ${i + 1}, branch "${name}", sub-step ${si + 1}: must be an object`);
          }
          const subKeys = Object.keys(sub as object);
          if (subKeys.length === 0) {
            throw new Error(`Step ${i + 1}, branch "${name}", sub-step ${si + 1}: empty`);
          }
          const subActionKey = subKeys.find(k => !metaKeys.has(k)) || subKeys[0];
          if (!VALID_ACTIONS.has(subActionKey) || subActionKey === "child") {
            throw new Error(
              `Step ${i + 1}, branch "${name}", sub-step ${si + 1}: unknown action "${subActionKey}"`
            );
          }
        }
      }
    }

    // Find approximate line number for error reporting
    let rawLine = 0;
    for (let j = lineOffset; j < lines.length; j++) {
      if (lines[j].includes(`- ${actionKey}:`)) {
        rawLine = j + 1;
        lineOffset = j + 1;
        break;
      }
    }

    steps.push(step as ScenarioStep);
  }

  return {
    name: data.name as string,
    description: typeof data.description === "string" ? data.description : undefined,
    env_file: envFile,
    stop_on_failure: stopOnFailure,
    variables,
    steps,
  };
}
