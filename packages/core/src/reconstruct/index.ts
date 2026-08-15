/**
 * `pkr reconstruct` — ARCHITECTURE.md §4 (M2). Loads a `.projectknowledge/`
 * directory (from any PKR-producing tool, not necessarily this generator —
 * portability, PKR_SPEC.md §0) and renders the `.reconstruction/` package.
 * No LLM call — purely mechanical rendering of the already-extracted graph.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadPkr } from "./loadPkr.js";
import { computeBuildOrder } from "./buildOrder.js";
import { renderReconstructionPackage } from "./render.js";

export interface ReconstructOptions {
  pkrDir: string;
  outDir?: string;
}

export interface ReconstructResult {
  outDir: string;
  writtenFiles: string[];
  nodeCount: number;
  loadSource: "jsonl" | "markdown-fallback";
  achievedLevel: number;
}

export function runReconstruct(options: ReconstructOptions): ReconstructResult {
  const pkrDir = path.resolve(options.pkrDir);
  if (!fs.existsSync(pkrDir) || !fs.statSync(pkrDir).isDirectory()) {
    throw new Error(`Not a directory: ${pkrDir}`);
  }

  const outDir = options.outDir ?? path.join(pkrDir, "..", ".reconstruction");
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  const { manifest, nodes, source } = loadPkr(pkrDir);
  const buildOrder = computeBuildOrder(nodes);

  const result = renderReconstructionPackage({
    outDir,
    manifest,
    nodes,
    buildOrder,
    loadSource: source,
  });

  return {
    outDir,
    writtenFiles: result.writtenFiles,
    nodeCount: nodes.length,
    loadSource: source,
    achievedLevel: manifest.reconstruction.target_level,
  };
}
