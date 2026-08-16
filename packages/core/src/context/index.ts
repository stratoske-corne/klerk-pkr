/**
 * `pkr context` — turns a `.projectknowledge/` directory into a single
 * continuation-context file for handing to an AI agent (any agent, any
 * session) that's about to keep working on this project. No LLM call —
 * reuses the same PKR loader as `pkr reconstruct` (jsonl or markdown
 * fallback, PKR_SPEC.md §8).
 *
 * Also computes a best-effort staleness check (ARCHITECTURE.md — agent-
 * instruction automation, chosen over a daemon/git-hook): re-walks the repo
 * with the same `buildInventory`/`diffInventory` machinery `pkr update`
 * uses, and surfaces a file-change count in the rendered output rather than
 * silently assuming the snapshot is current. Never fails `pkr context` over
 * this — a repo root that can't be walked (moved, deleted, a portability
 * copy with no baseline inventory) just means staleness is reported as
 * unknown, not that the command errors out.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadPkr } from "../reconstruct/loadPkr.js";
import { buildInventory, loadInventory } from "../extract/inventory.js";
import { diffInventory } from "../update/diffInventory.js";
import { renderContextPackage, type ContextTarget, type StalenessCheck } from "./render.js";

export interface ContextOptions {
  pkrDir: string;
  outDir?: string;
  target?: ContextTarget;
  /** Repo to check for drift against this PKR. Defaults to the PKR directory's parent (the `<repo>/.projectknowledge` convention `pkr export`/`pkr update` both use). */
  repoRoot?: string;
}

export interface ContextResult {
  outDir: string;
  filePath: string;
  nodeCount: number;
  loadSource: "jsonl" | "markdown-fallback";
  target: ContextTarget;
  staleness: StalenessCheck;
}

/** Best-effort only — see module doc. Returns null on anything short of a clean diff. */
function checkStaleness(pkrDir: string, repoRoot: string): StalenessCheck {
  try {
    const knowledgeDir = path.join(pkrDir, ".knowledge");
    const previousInventory = loadInventory(knowledgeDir);
    if (previousInventory === null) return null; // no baseline to diff against (predates inventory persistence, or a portability copy)
    if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) return null;

    const freshInventory = buildInventory(repoRoot);
    const diff = diffInventory(previousInventory, freshInventory.files);
    return { changedFileCount: diff.added.length + diff.modified.length + diff.removed.length };
  } catch {
    return null;
  }
}

export function runContext(options: ContextOptions): ContextResult {
  const pkrDir = path.resolve(options.pkrDir);
  if (!fs.existsSync(pkrDir) || !fs.statSync(pkrDir).isDirectory()) {
    throw new Error(`Not a directory: ${pkrDir}`);
  }

  const target = options.target ?? "generic";
  const outDir = options.outDir ?? path.join(pkrDir, "..", ".context");
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : path.resolve(pkrDir, "..");

  const { manifest, nodes, edges, source } = loadPkr(pkrDir);
  const staleness = checkStaleness(pkrDir, repoRoot);

  const result = renderContextPackage({
    outDir,
    target,
    manifest,
    nodes,
    edges,
    generatedAt: manifest.knowledge.generated_at,
    staleness,
  });

  return {
    outDir,
    filePath: result.filePath,
    nodeCount: nodes.length,
    loadSource: source,
    target,
    staleness,
  };
}
