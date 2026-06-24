import { buildCLI } from "./cli.js";

async function main() {
  const program = buildCLI();
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
