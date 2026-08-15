#!/usr/bin/env node
import { Command } from "commander";
import * as path from "node:path";
import { runExport, tryCreateDefaultLlmClient, AnthropicLlmClient, runReconstruct } from "@klerk/core";

const program = new Command();

program
  .name("pkr")
  .description("Klerk — generate and manage a Project Knowledge Repository (.projectknowledge/) for a software repository.")
  .version("0.1.0");

program
  .command("export")
  .description("Analyze a repository and generate .projectknowledge/. Full regeneration — see PRODUCT_SPEC.md §4.")
  .argument("<repo>", "path to the repository to analyze")
  .option("-o, --out <dir>", "output directory (default: <repo>/.projectknowledge)")
  .option("--no-llm", "skip stage 6 (LLM synthesis of product/behavior knowledge) even if an API key is available")
  .option("--model <model>", "override the LLM model used for synthesis (default: claude-sonnet-5, or $PKR_LLM_MODEL)")
  .action(async (repo: string, opts: { out?: string; llm: boolean; model?: string }) => {
    const repoRoot = path.resolve(process.cwd(), repo);
    console.log(`Analyzing ${repoRoot} ...`);

    let llm = null;
    if (opts.llm) {
      llm = opts.model ? new AnthropicLlmClient({ model: opts.model }) : tryCreateDefaultLlmClient();
      if (!llm) {
        console.log("(no ANTHROPIC_API_KEY set — skipping stage 6 semantic synthesis; deterministic extraction only)");
      }
    }

    const result = await runExport({
      repoRoot,
      outDir: opts.out ? path.resolve(process.cwd(), opts.out) : undefined,
      llm,
    });

    console.log("");
    console.log(`✓ Wrote ${result.writtenFiles.length} file(s) to ${path.relative(process.cwd(), result.outDir)}/`);
    console.log(`  Nodes: ${result.nodeCount}   Edges: ${result.edgeCount}`);
    console.log(`  Achieved reconstruction level: ${result.achievedLevel} (see PKR_SPEC.md §3)`);
    if (result.totalRedactions > 0) {
      console.log(`  ⚠ ${result.totalRedactions} likely secret value(s) were redacted before export.`);
    }

    if (result.synthesis) {
      if (result.synthesis.ranSuccessfully) {
        console.log("");
        console.log(
          `  Stage 6 (LLM synthesis): proposed ${result.synthesis.nodeCount} node(s) from ${result.synthesis.excerptFiles.length} excerpt file(s)` +
            (result.synthesis.skipped.length ? `, dropped ${result.synthesis.skipped.length} for unverifiable evidence.` : "."),
        );
        for (const s of result.synthesis.skipped) {
          console.log(`    - skipped "${s.title}": ${s.reason}`);
        }
      } else {
        console.log("");
        console.log(`  ⚠ Stage 6 (LLM synthesis) failed and was skipped: ${result.synthesis.error}`);
      }
    } else {
      console.log("");
      console.log("  Stage 6 (LLM synthesis) did not run — product/ and behavior/ sections are empty.");
      console.log("  Set ANTHROPIC_API_KEY and re-run without --no-llm to include them.");
    }
  });

program
  .command("reconstruct")
  .description("Turn a .projectknowledge/ directory into a .reconstruction/ package for a fresh AI coding agent. No LLM call — see ARCHITECTURE.md §4.")
  .argument("<pkr-dir>", "path to a .projectknowledge/ directory")
  .option("-o, --out <dir>", "output directory (default: sibling .reconstruction/ next to the PKR dir)")
  .action((pkrDir: string, opts: { out?: string }) => {
    const resolvedPkrDir = path.resolve(process.cwd(), pkrDir);
    console.log(`Loading ${resolvedPkrDir} ...`);

    const result = runReconstruct({
      pkrDir: resolvedPkrDir,
      outDir: opts.out ? path.resolve(process.cwd(), opts.out) : undefined,
    });

    console.log("");
    console.log(`✓ Wrote ${result.writtenFiles.length} file(s) to ${path.relative(process.cwd(), result.outDir)}/`);
    console.log(`  Loaded ${result.nodeCount} node(s) from ${result.loadSource === "jsonl" ? "the internal store (.knowledge/*.jsonl)" : "markdown files (no .knowledge/ store found — portability fallback)"}`);
    console.log(`  PKR claims reconstruction level: ${result.achievedLevel} (see PKR_SPEC.md §3)`);
  });

program.parseAsync(process.argv);
