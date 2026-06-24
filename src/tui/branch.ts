import { createInterface } from "readline";
import { stdin, stdout } from "process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CACHE_DIR = join(homedir(), ".batman");
const CACHE_FILE = join(CACHE_DIR, "cache.json");

function loadCache(): Record<string, string> {
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {}
  return {};
}

function saveCache(cache: Record<string, string>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

// ─── Radio (single-select) ─────────────────────────────────

export async function selectBranch(
  branches: string[],
  stepIndex: number,
  cacheKey?: string,
  labels?: string[],
  rememberLast?: boolean
): Promise<number> {
  const display = labels ?? branches;
  const cache = loadCache();
  const saved = cacheKey ? cache[cacheKey] : undefined;
  const savedIdx = saved ? branches.indexOf(saved) : -1;

  // Skip TUI if remember-last or non-TTY
  if (rememberLast || !stdin.isTTY) {
    const defaultBranch = savedIdx >= 0 ? saved! : branches[0];
    console.log(`  Step ${stepIndex} → ${defaultBranch} (auto)`);
    return savedIdx >= 0 ? savedIdx : 0;
  }

  if (branches.length === 1) return 0;

  const rl = createInterface({ input: stdin, output: stdout });
  let selected = savedIdx >= 0 ? savedIdx : 0;

  return new Promise((resolve) => {
    const rawMode = stdin.isTTY;
    if (rawMode) stdin.setRawMode(true);
    stdin.resume();

    function render() {
      stdout.write("\x1b[2J\x1b[H");
      stdout.write(`\n  Step ${stepIndex} — Choose:\n\n`);
      for (let i = 0; i < display.length; i++) {
        const prefix = i === selected ? "  ●" : "  ○";
        const suffix = i === savedIdx ? " (last)" : "";
        stdout.write(`  ${prefix} ${display[i]}${suffix}\n`);
      }
      stdout.write(`\n  [↑↓] Navigate   [Enter] Select\n`);
    }

    render();

    stdin.on("data", (key: Buffer) => {
      const byte = key[0];
      if (byte === 13) {
        if (cacheKey) { cache[cacheKey] = branches[selected]; saveCache(cache); }
        cleanup(); resolve(selected);
      } else if (byte === 27 && key[1] === 91) {
        const code = key[2];
        if (code === 65) { selected = selected > 0 ? selected - 1 : branches.length - 1; render(); }
        else if (code === 66) { selected = selected < branches.length - 1 ? selected + 1 : 0; render(); }
      } else if (byte === 3 || byte === 27) { cleanup(); resolve(selected); }
    });

    function cleanup() {
      stdin.removeAllListeners("data");
      if (rawMode) stdin.setRawMode(false);
      stdin.pause(); rl.close();
      stdout.write("\x1b[2J\x1b[H");
    }
  });
}

// ─── Checkbox (multi-select) ───────────────────────────────

export async function selectBranches(
  branches: string[],
  stepIndex: number,
  cacheKey?: string,
  labels?: string[],
  rememberLast?: boolean
): Promise<number[]> {
  const display = labels ?? branches;
  const cache = loadCache();
  const savedStr = cacheKey ? cache[cacheKey] : undefined;
  const defaultSelected = new Set<number>();

  if (savedStr) {
    const savedNames = savedStr.split(",").map(s => s.trim());
    for (const name of savedNames) {
      const idx = branches.indexOf(name);
      if (idx >= 0) defaultSelected.add(idx);
    }
  }

  if (rememberLast || !stdin.isTTY) {
    if (defaultSelected.size > 0) {
      const names = [...defaultSelected].map(i => branches[i]).join(", ");
      console.log(`  Step ${stepIndex} → [${names}] (auto)`);
      return [...defaultSelected];
    }
    // No cache and non-interactive: skip all (user must select explicitly)
    console.log(`  Step ${stepIndex} → [none] (auto — use interactive mode to select)`);
    return [];
  }

  if (branches.length === 1) return [0];

  const rl = createInterface({ input: stdin, output: stdout });
  let cursor = savedIdx(branches, defaultSelected);
  const selected = new Set<number>(defaultSelected);

  return new Promise((resolve) => {
    const rawMode = stdin.isTTY;
    if (rawMode) stdin.setRawMode(true);
    stdin.resume();

    function render() {
      stdout.write("\x1b[2J\x1b[H");
      stdout.write(`\n  Step ${stepIndex} — Select (multiple):\n\n`);
      for (let i = 0; i < display.length; i++) {
        const mark = selected.has(i) ? "✔" : " ";
        const pointer = i === cursor ? "●" : "○";
        stdout.write(`  ${pointer}  [${mark}] ${display[i]}\n`);
      }
      stdout.write(`\n  [↑↓] Navigate   [Space] Toggle   [A] Select/Deselect All   [Enter] Confirm\n`);
    }

    render();

    stdin.on("data", (key: Buffer) => {
      const byte = key[0];
      if (byte === 13) {
        const result = selected.size > 0 ? [...selected] : [];
        if (cacheKey) {
          cache[cacheKey] = result.map(i => branches[i]).join(",");
          saveCache(cache);
        }
        cleanup(); resolve(result);
      } else if (byte === 32) {
        // Space
        if (selected.has(cursor)) { selected.delete(cursor); }
        else { selected.add(cursor); }
        render();
      } else if (byte === 97 || byte === 65) {
        // "a" or "A" — toggle select all / deselect all
        if (selected.size === branches.length) {
          selected.clear();
        } else {
          for (let i = 0; i < branches.length; i++) selected.add(i);
        }
        render();
      } else if (byte === 27 && key[1] === 91) {
        const code = key[2];
        if (code === 65) { cursor = cursor > 0 ? cursor - 1 : branches.length - 1; render(); }
        else if (code === 66) { cursor = cursor < branches.length - 1 ? cursor + 1 : 0; render(); }
      } else if (byte === 3 || byte === 27) {
        const result = selected.size > 0 ? [...selected] : [0];
        cleanup(); resolve(result);
      }
    });

    function cleanup() {
      stdin.removeAllListeners("data");
      if (rawMode) stdin.setRawMode(false);
      stdin.pause(); rl.close();
      stdout.write("\x1b[2J\x1b[H");
    }
  });
}

function savedIdx(branches: string[], selected: Set<number>): number {
  if (selected.size > 0) return [...selected][0];
  return 0;
}
