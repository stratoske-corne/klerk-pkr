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
import { computeSupersededIds } from "../supersede.js";

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

  const { manifest, nodes: allNodes, edges, source } = loadPkr(pkrDir);
  // ARCHITECTURE.md §19 — same exclusion as render.ts/context/render.ts,
  // for the same reason: a superseded (non-confirmed) fact must not sit
  // next to the current one that replaced it. Found missing here the same
  // way it was found missing in context/render.ts — this is a third,
  // independent render path with its own node selection, not a variant of
  // either of the other two. No dedicated "superseded" output here (unlike
  // render.ts's superseded.md) — a build spec has no use for facts that are
  // already known to be wrong, and the permanent record already lives in
  // the main PKR this was generated from.
  const supersededIds = computeSupersededIds(allNodes, edges);
  const nodes = allNodes.filter((n) => !supersededIds.has(n.id));
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
