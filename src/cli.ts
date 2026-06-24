import { Command } from "commander";
import { runAll } from "./runner/orchestrator.js";
import { parseScenario } from "./engine/parser.js";
import { resolveVariables, loadEnvFile, clearCache as clearVarCache } from "./engine/variables.js";
import { compileSteps } from "./engine/compiler.js";
import { resolve, dirname } from "path";
import { VALID_BROWSERS, type RunOptions } from "./types.js";

export function buildCLI(): Command {
  const program = new Command();

  program
    .name("batman")
    .description("Browser Automation Test Manager And Navigator")
    .version("0.1.0");

  program
    .command("run")
    .description("Execute a YAML scenario against target websites")
    .requiredOption("-s, --scenario <path>", "Path to YAML scenario file")
    .requiredOption("-u, --url <urls...>", "Target URL(s) to test")
    .option("-b, --browser <names...>", "Browsers to use", ["chromium"])
    .option("-m, --mode <mode>", "Execution mode: sequential | parallel", "sequential")
    .option("-o, --output <dir>", "Output directory for artifacts", "./output")
    .option("-t, --timeout <ms>", "Step timeout in milliseconds", "30000")
    .option("--headed", "Run browsers with visible UI", false)
    .option("-v, --verbose", "Verbose output during execution", false)
    .option("--dry-run", "Parse, resolve, and compile scenario without executing", false)
    .option("-r, --retries <n>", "Number of retries for failed steps", "0")
    .option("-w, --workers <n>", "Max parallel workers (defaults to browser count)", "0")
    .option("--clear-cache", "Clear cached variable values before running", false)
    .option("--remember-last-option", "Skip prompts and use last choices", false)
    .option("--env-file <path>", "Load environment variables from a .env file")
    .option("--user-agent <ua>", "Custom browser user agent string")
    .option("--profile <path>", "Path to browser user data directory for persistent profile (cookies/sessions survive runs)")
    .option("--channel <name>", "Browser channel: chrome, msedge, chrome-beta, etc. (use with --profile for system browser)")
    .option("--resolution <WxH|preset>", "Viewport: 1920x1080, 720p, 1080p, 2k, 4k (default: 1280x720)")
    .action(async (opts) => {
      // Validate browsers
      const browsers = (opts.browser as string[]).map((b) => b.toLowerCase());
      for (const b of browsers) {
        if (!VALID_BROWSERS.includes(b as never)) {
          console.error(
            `Invalid browser: "${b}". Valid options: ${VALID_BROWSERS.join(", ")}`
          );
          process.exit(1);
        }
      }

      // Validate mode
      const mode = opts.mode as string;
      if (mode !== "sequential" && mode !== "parallel") {
        console.error(`Invalid mode: "${mode}". Must be "sequential" or "parallel".`);
        process.exit(1);
      }

      // Resolve scenario path
      const scenarioPath = resolve(opts.scenario as string);

      const options: RunOptions = {
        scenario: scenarioPath,
        urls: opts.url as string[],
        browsers: browsers as RunOptions["browsers"],
        mode: mode as RunOptions["mode"],
        outputDir: opts.output as string,
        timeout: parseInt(opts.timeout as string, 10),
        headed: opts.headed as boolean,
        verbose: opts.verbose as boolean,
        dryRun: opts.dryRun as boolean,
        retries: parseInt(opts.retries as string, 10),
        maxWorkers: parseInt(opts.workers as string, 10) || browsers.length,
        clearCache: opts.clearCache as boolean,
        envFile: opts.envFile as string | undefined,
        rememberLast: opts.rememberLastOption as boolean,
        userAgent: opts.userAgent as string | undefined,
        profile: opts.profile as string | undefined,
        channel: opts.channel as string | undefined,
        resolution: opts.resolution as string | undefined,
      };

      // Log profile usage
      if (options.profile) {
        console.log(`   Profile  : ${options.profile}${options.channel ? ` (channel: ${options.channel})` : ""}`);
      }

      // Handle env file and cache
      if (options.clearCache) clearVarCache();
      if (options.envFile) loadEnvFile(options.envFile);

      console.log(`\n🦇 BATMAN v0.1.0 — Browser Automation Test Manager And Navigator`);
      console.log(`   Scenario : ${options.scenario}`);
      console.log(`   Sites    : ${options.urls.join(", ")}`);
      console.log(`   Browsers : ${options.browsers.join(", ")}`);
      console.log(`   Mode     : ${options.mode}`);
      console.log(`   Output   : ${options.outputDir}\n`);

      // Parse scenario
      const parsed = parseScenario(options.scenario);

      // Load env_file from scenario (before resolving variables)
      if (parsed.env_file) {
        const scenarioDir = dirname(resolve(options.scenario));
        const files = Array.isArray(parsed.env_file) ? parsed.env_file : [parsed.env_file];
        for (const file of files) {
          loadEnvFile(resolve(scenarioDir, file));
        }
      }

      if (options.dryRun) {
        const resolved = await resolveVariables(parsed, options.clearCache, options.rememberLast);
        const compiled = compileSteps(resolved);
        console.log(`✅ Scenario "${parsed.name}" — valid (${compiled.length} steps)`);
        console.log(`   Variables: ${Object.keys(parsed.variables ?? {}).length || 0} defined`);
        console.log("\n   Compiled steps:");
        for (const step of compiled) {
          console.log(
            `   ${step.index}. ${step.type}(${JSON.stringify(step.params)})`
          );
        }
        console.log();
        process.exit(0);
      }

      // Execute
      await runAll(options);
    });

  return program;
}
