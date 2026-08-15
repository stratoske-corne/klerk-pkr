/**
 * `pkr context` — turns a `.projectknowledge/` directory into a single
 * continuation-context file for handing to an AI agent (any agent, any
 * session) that's about to keep working on this project. No LLM call —
 * reuses the same PKR loader as `pkr reconstruct` (jsonl or markdown
 * fallback, PKR_SPEC.md §8).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadPkr } from "../reconstruct/loadPkr.js";
import { renderContextPackage, type ContextTarget } from "./render.js";

export interface ContextOptions {
  pkrDir: string;
  outDir?: string;
  target?: ContextTarget;
}

export interface ContextResult {
  outDir: string;
  filePath: string;
  nodeCount: number;
  loadSource: "jsonl" | "markdown-fallback";
  target: ContextTarget;
}

export function runContext(options: ContextOptions): ContextResult {
  const pkrDir = path.resolve(options.pkrDir);
  if (!fs.existsSync(pkrDir) || !fs.statSync(pkrDir).isDirectory()) {
    throw new Error(`Not a directory: ${pkrDir}`);
  }

  const target = options.target ?? "generic";
  const outDir = options.outDir ?? path.join(pkrDir, "..", ".context");

  const { manifest, nodes, source } = loadPkr(pkrDir);

  const result = renderContextPackage({
    outDir,
    target,
    manifest,
    nodes,
    generatedAt: manifest.knowledge.generated_at,
  });

  return {
    outDir,
    filePath: result.filePath,
    nodeCount: nodes.length,
    loadSource: source,
    target,
  };
}
