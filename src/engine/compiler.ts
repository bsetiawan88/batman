import type { ParsedScenario, ScenarioStep, CompiledStep } from "../types.js";

const pad = (n: number) => String(n).padStart(2, "0");

export function compileSteps(
  scenario: ParsedScenario,
  parentLabel?: string
): CompiledStep[] {
  const compiled: CompiledStep[] = [];

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    const keys = Object.keys(step);

    // Extract `when` condition if present
    const actionKeys = keys.filter(k => k !== "when" && k !== "if");
    const type = actionKeys[0];
    const params = (step as Record<string, unknown>)[type];
    const condition = (step as Record<string, unknown>).when as string | undefined;

    const label = parentLabel
      ? `${parentLabel}-${pad(i + 1)}`
      : pad(i + 1);

    const compiledStep: CompiledStep = {
      index: i + 1,
      type,
      params: normalizeParams(type, params),
      rawLine: 0,
      label,
      condition,
      on_fail: extractOnFail(params) ?? (scenario.stop_on_failure ? "stop" : undefined),
    };

    // Compile child branches recursively
    if (type === "child" && params) {
      const childObj = params as Record<string, unknown>;
      const childType = (childObj.type as string) || "radio";
      compiledStep.childType = childType as "radio" | "checkbox";

      const branchEntries = Object.entries(childObj).filter(([k]) =>
        k !== "type" && k !== "on_empty" && k !== "when" && k !== "var"
      );
      compiledStep.children = {};
      compiledStep.childLabels = {};

      // `when` at child level = condition for all branches
      if (childObj.when) compiledStep.condition = childObj.when as string;

      // `var` = save selected branch names to this variable
      if (childObj.var) compiledStep.varName = childObj.var as string;

      // Compile on_empty fallback (for checkbox — runs when nothing selected)
      if (childObj.on_empty) {
        compiledStep.onEmpty = compileSteps(
          { name: "child:on-empty", steps: childObj.on_empty as ScenarioStep[] },
          label
        );
      }

      for (const [branchName, subSteps] of branchEntries) {
        const steps = subSteps as unknown[];
        // Extract label if first element is a string
        if (typeof steps[0] === "string") {
          compiledStep.childLabels[branchName] = steps[0] as string;
          steps.shift();
        }
        compiledStep.children[branchName] = compileSteps(
          {
            name: `child:${branchName}`,
            steps: steps as ScenarioStep[],
            stop_on_failure: scenario.stop_on_failure,
          },
          label
        );
      }
    } else {
      validateParams(type, compiledStep.params, i + 1);
    }

    compiled.push(compiledStep);
  }

  return compiled;
}

function normalizeParams(type: string, params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object") return {};
  return params as Record<string, unknown>;
}

const REQUIRED_PARAMS: Record<string, string[]> = {
  goto: ["url"],
  click: ["selector"],
  fill: ["selector", "value"],
  select: ["selector", "value"],
  check: ["selector"],
  uncheck: ["selector"],
  upload: ["selector", "files"],
  press: ["key"],
  drag: ["source", "target"],
  request: ["method", "url"],
  db_query: ["engine", "connection", "query"],
  assert: ["selector"],
  assert_text: ["text"],
  assert_url: ["url"],
  assert_count: ["selector", "count"],
  assert_visible: ["selector"],
  assert_hidden: ["selector"],
  assert_value: ["selector", "value"],
  assert_json: ["source", "path"],
  assert_db: ["source"],
  wait_for_function: ["fn"],
};

function validateParams(
  type: string,
  params: Record<string, unknown>,
  stepNum: number
): void {
  const required = REQUIRED_PARAMS[type];
  if (!required) return;

  for (const param of required) {
    if (params[param] === undefined || params[param] === null) {
      throw new Error(
        `Step ${stepNum}: action "${type}" requires parameter "${param}"`
      );
    }
  }

  if (type === "request") {
    const validMethods = ["GET", "POST", "PUT", "DELETE"];
    if (!validMethods.includes(params.method as string)) {
      throw new Error(
        `Step ${stepNum}: request method must be one of: ${validMethods.join(", ")}`
      );
    }
  }

  if (type === "db_query") {
    const validEngines = ["sqlite", "postgres", "mysql"];
    if (!validEngines.includes(params.engine as string)) {
      throw new Error(
        `Step ${stepNum}: db_query engine must be one of: ${validEngines.join(", ")}`
      );
    }
  }

  if (type === "wait") {
    const hasMs = params.ms !== undefined;
    const hasSelector = params.selector !== undefined;
    const hasUrl = params.url !== undefined;
    if (!hasMs && !hasSelector && !hasUrl) {
      throw new Error(
        `Step ${stepNum}: "wait" requires at least one of: ms, selector, url`
      );
    }
  }

  if (type === "assert_db") {
    const hasExists = params.exists !== undefined;
    const hasEquals = params.equals !== undefined;
    if (!hasExists && hasEquals === undefined) {
      throw new Error(
        `Step ${stepNum}: "assert_db" requires at least one of: exists, equals`
      );
    }
  }

  if (type === "assert_json") {
    const hasEquals = params.equals !== undefined;
    const hasContains = params.contains !== undefined;
    if (!hasEquals && !hasContains) {
      throw new Error(
        `Step ${stepNum}: "assert_json" requires at least one of: equals, contains`
      );
    }
  }
}

function extractOnFail(params: unknown): "stop" | "continue" | undefined {
  if (params && typeof params === "object" && "on_fail" in params) {
    const val = (params as Record<string, unknown>).on_fail;
    if (val === "stop" || val === "continue") return val;
  }
  return undefined;
}
