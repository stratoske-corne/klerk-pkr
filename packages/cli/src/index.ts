#!/usr/bin/env node
import { Command } from "commander";
import * as path from "node:path";
import { runExport, tryCreateDefaultLlmClient, AnthropicLlmClient, runReconstruct, runContext, runUpdate, type ContextTarget, type KnowledgeNode } from "@klerk/core";

const program = new Command();

/**
 * `pkr update`'s "modified" line used to always print `title → title`,
 * which told a human nothing when a file changed but the extracted title
 * didn't move (the common case — most edits touch content or evidence, not
 * the title). `mergeDeterministicNodes`'s `contentEquivalent` check
 * guarantees at least one of title/content/evidence actually differs
 * whenever a node lands in `modified`, so report whichever it actually was.
 */
function describeNodeModification(before: KnowledgeNode, after: KnowledgeNode): string {
  if (before.title !== after.title) return `${before.title} → ${after.title}`;
  const changed: string[] = [];
  if (before.content !== after.content) changed.push("content");
  if (JSON.stringify(before.evidence) !== JSON.stringify(after.evidence)) changed.push("evidence");
  return `${after.title} (${changed.join(", ")} changed)`;
}

program
  .name("pkr")
  .description("Klerk — generate and manage a Project Knowledge Repository (.projectknowledge/) for a software repository.")
  .version("0.1.0");

program
  .command("export")
  .alias("init")
  .description("Analyze a repository and generate .projectknowledge/ (aliased as `init` — this is the command to run when you first open an unfamiliar repo). Full regeneration — see PRODUCT_SPEC.md §4.")
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
        if (result.synthesis.weaklyGrounded.length > 0) {
          console.log(`  ⚠ ${result.synthesis.weaklyGrounded.length} node(s) kept but weakly grounded (evidence path was real but its content was never shown to the model — worth a closer look):`);
          for (const w of result.synthesis.weaklyGrounded) {
            console.log(`    - ${w.id}: "${w.title}"`);
          }
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

    console.log("");
    console.log(`  Next: hand this to an AI agent with \`pkr context ${path.relative(process.cwd(), result.outDir)}\``);
    console.log("  (or just point the agent at the .projectknowledge/ directory directly — it's plain files).");
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

program
  .command("context")
  .description("Turn a .projectknowledge/ directory into a single continuation-context file for an AI agent that's about to keep working on this project (not a rebuild spec — see `pkr reconstruct` for that). No LLM call.")
  .argument("<pkr-dir>", "path to a .projectknowledge/ directory")
  .option("-o, --out <dir>", "output directory (default: sibling .context/ next to the PKR dir)")
  .option("--target <target>", "claude | codex | generic (default: generic — content is identical today, only the filename/framing differs)", "generic")
  .option("--repo <dir>", "repository to check for drift against this PKR (default: the PKR directory's parent)")
  .action((pkrDir: string, opts: { out?: string; target: string; repo?: string }) => {
    const resolvedPkrDir = path.resolve(process.cwd(), pkrDir);
    const target = opts.target as ContextTarget;
    if (!["claude", "codex", "generic"].includes(target)) {
      console.error(`Invalid --target "${opts.target}" — must be one of: claude, codex, generic`);
      process.exitCode = 1;
      return;
    }

    console.log(`Loading ${resolvedPkrDir} ...`);
    const result = runContext({
      pkrDir: resolvedPkrDir,
      outDir: opts.out ? path.resolve(process.cwd(), opts.out) : undefined,
      target,
      repoRoot: opts.repo ? path.resolve(process.cwd(), opts.repo) : undefined,
    });

    console.log("");
    console.log(`✓ Wrote ${path.relative(process.cwd(), result.filePath)}`);
    console.log(`  Loaded ${result.nodeCount} node(s) from ${result.loadSource === "jsonl" ? "the internal store (.knowledge/*.jsonl)" : "markdown files (no .knowledge/ store found — portability fallback)"}`);
    if (result.staleness === null) {
      console.log("  ⚠ Could not determine staleness (no baseline inventory, or the repo root wasn't reachable).");
    } else if (result.staleness.changedFileCount > 0) {
      console.log(`  ⚠ Stale: ${result.staleness.changedFileCount} file(s) changed since this PKR was last generated/updated — consider running \`pkr update\` first.`);
    } else {
      console.log("  ✓ Up to date with the repository.");
    }
    console.log("  Hand this single file to an AI agent at the start of a session to continue work without re-explaining the project.");
  });

program
  .command("update")
  .description("Incrementally re-sync .projectknowledge/ with the current repository state. Preserves node IDs and confirmed knowledge — see PKR_SPEC.md §4.2, ARCHITECTURE.md §17.")
  .argument("<repo>", "path to the repository (must already have a .projectknowledge/ from `pkr export`)")
  .option("-o, --out <dir>", "PKR directory (default: <repo>/.projectknowledge)")
  .option("--llm", "also re-run stage 6 (LLM synthesis) — additive only in this version, see the module doc")
  .option("--model <model>", "override the LLM model used for synthesis (default: claude-sonnet-5, or $PKR_LLM_MODEL)")
  .action(async (repo: string, opts: { out?: string; llm?: boolean; model?: string }) => {
    const repoRoot = path.resolve(process.cwd(), repo);
    console.log(`Checking ${repoRoot} for changes ...`);

    let llm = null;
    if (opts.llm) {
      llm = opts.model ? new AnthropicLlmClient({ model: opts.model }) : tryCreateDefaultLlmClient();
      if (!llm) console.log("(no ANTHROPIC_API_KEY set — skipping stage 6; deterministic update only)");
    }

    const result = await runUpdate({
      repoRoot,
      outDir: opts.out ? path.resolve(process.cwd(), opts.out) : undefined,
      llm,
    });

    if (result.upToDate) {
      console.log("");
      console.log("✓ Up to date — no file changes detected since the last export/update.");
      return;
    }

    console.log("");
    console.log(
      `Changed files: +${result.fileDiff.added.length} ~${result.fileDiff.modified.length} -${result.fileDiff.removed.length}` +
        ` (${result.fileDiff.unchanged} unchanged)`,
    );

    const merge = result.nodeMerge!;
    console.log("");
    console.log("Knowledge diff:");
    if (merge.added.length === 0 && merge.modified.length === 0 && merge.removed.length === 0 && merge.conflicts.length === 0) {
      console.log("  No fact-level changes (changed files didn't affect any extracted knowledge).");
    }
    for (const n of merge.added) console.log(`  + ${n.id}  ${n.title}`);
    for (const { before, after } of merge.modified) console.log(`  ~ ${after.id}  ${describeNodeModification(before, after)}`);
    for (const n of merge.removed) console.log(`  - ${n.id}  ${n.title}`);
    for (const { existing } of merge.conflicts) {
      console.log(`  ! ${existing.id}  "${existing.title}" is confirmed but extraction now disagrees — needs manual review`);
    }
    console.log(`  (${merge.unchangedCount} facts unchanged)`);

    if (result.llm) {
      console.log("");
      if (result.llm.ranSuccessfully) {
        console.log(`Stage 6: proposed ${result.llm.added.length} new node(s)${result.llm.skipped.length ? `, dropped ${result.llm.skipped.length} for unverifiable evidence` : ""}.`);
        for (const n of result.llm.added) console.log(`  + ${n.id}  ${n.title}`);
        if (result.llm.weaklyGrounded.length > 0) {
          console.log(`  ⚠ ${result.llm.weaklyGrounded.length} node(s) kept but weakly grounded (evidence path was real but its content was never shown to the model):`);
          for (const w of result.llm.weaklyGrounded) console.log(`    - ${w.id}: "${w.title}"`);
        }
        for (const { newNode, target } of result.llm.superseded) {
          console.log(`  ~ superseded ${target.id} "${target.title}"`);
          console.log(`      → replaced by ${newNode.id} "${newNode.title}" (see superseded.md)`);
        }
        for (const { target } of result.llm.conflicts) {
          console.log(`  ! ${target.id}  "${target.title}" is confirmed but extraction now disagrees — needs manual review`);
        }
      } else {
        console.log(`⚠ Stage 6 failed: ${result.llm.error}`);
        console.log("  (the file changes that triggered this run were NOT marked as synced — just run `pkr update --llm` again to retry)");
      }
    }

    console.log("");
    console.log(`✓ Wrote ${result.writtenFiles.length} file(s) to ${path.relative(process.cwd(), result.outDir)}/`);
    console.log(`  Achieved reconstruction level: ${result.achievedLevel} (see PKR_SPEC.md §3)`);
  });

// Every command action above can throw a plain `Error` from core (bad path,
// missing PKR, malformed manifest, etc. — see e.g. pipeline.ts's "Not a
// directory" checks). Without this, an async action's rejection reaches
// Node uncaught: a raw stack trace into compiled `dist/` files, no clean
// message, exit code from the runtime rather than us. Found by actually
// running the CLI with the kind of mistakes a first-time user makes (wrong
// path, no `.projectknowledge/` yet, typo'd flag) — every one of those
// crashed instead of erroring cleanly, despite each underlying error message
// already being clear and actionable on its own. One central catch here
// rather than wrapping every `.action()` individually — same clean-message
// pattern the `context` command's own `--target` validation already used,
// now applied consistently everywhere instead of in just the one place a
// bug report happened to point at (the same lesson as ARCHITECTURE.md §19's
// superseded-node fix, applied to error handling this time).
program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nError: ${message}`);
  if (process.env.PKR_DEBUG && err instanceof Error && err.stack) {
    console.error(`\n${err.stack}`);
  }
  process.exitCode = 1;
});
