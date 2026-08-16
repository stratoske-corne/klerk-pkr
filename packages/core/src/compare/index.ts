/**
 * `pkr compare` — ARCHITECTURE.md §5 / §25, PRODUCT_SPEC.md §5.8.
 *
 * Compares an original PKR against a candidate reconstruction (a real repo
 * — typically the output of an agent that followed `.reconstruction/`).
 * Every row is explicitly labeled `measured`, `heuristic`, or
 * `not-measurable` (PROMPT §17: "do not fake precision") — there is no
 * unlabeled single score.
 *
 * MVP scope, deliberately narrower than the full §5 table: API and schema
 * compatibility are name-set diffs (not shape/column-level — that would
 * mean parsing structured detail back out of free-text node `content`,
 * fragile and not built here); architecture similarity is a heuristic
 * Jaccard similarity over component names; build/test success actually
 * executes the reconstruction's own `npm run build`/`npm test`, but only
 * when `--run-build` is explicitly passed — running code from a
 * reconstruction (typically written by a different agent) is a real
 * category of risk nothing else in this codebase does by default (every
 * other subprocess call here is a fixed, argument-safe `git rev-parse
 * HEAD`). Deferred entirely: black-box contract-test execution of the
 * *original's* test suite against the reconstruction (needs contract-test
 * detection that doesn't exist), and a compound "behavioral similarity"
 * rollup (better once the rows above are validated against something
 * real).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import { loadPkr } from "../reconstruct/loadPkr.js";
import { buildInventory } from "../extract/inventory.js";
import { analyzeStructure } from "../extract/structure.js";
import { analyzeApiEndpoints, analyzeDatabaseSchema } from "../extract/interfaces.js";
import { IdAllocator } from "../ids.js";
import type { KnowledgeNode } from "../types.js";

export type CompareRowKind = "measured" | "heuristic" | "not-measurable";

export interface CompareRow {
  dimension: string;
  kind: CompareRowKind;
  summary: string;
  /** 0-1, higher is more similar/successful. Null when kind is "not-measurable". */
  score: number | null;
  detail?: string[];
}

export interface CompareResult {
  rows: CompareRow[];
  /** Weighted average of every row that has a score. Null if no row was measurable. */
  overallScore: number | null;
  /** Equal weight across scored rows, printed explicitly — never a black box (ARCHITECTURE.md §5). */
  weights: Record<string, number>;
}

export interface CompareOptions {
  originalPkrDir: string;
  reconstructionRepoDir: string;
  /** Actually execute the reconstruction's own build/test npm scripts. Default false — see module doc. */
  runBuild?: boolean;
}

function titleSet(nodes: KnowledgeNode[], type: KnowledgeNode["type"]): Set<string> {
  return new Set(nodes.filter((n) => n.type === type).map((n) => n.title));
}

function compareSets(dimension: string, original: Set<string>, candidate: Set<string>): CompareRow {
  if (original.size === 0) {
    return { dimension, kind: "not-measurable", summary: `The original PKR has no extracted ${dimension.toLowerCase()} facts to compare against.`, score: null };
  }
  const matched = [...original].filter((t) => candidate.has(t)).sort();
  const missing = [...original].filter((t) => !candidate.has(t)).sort();
  const extra = [...candidate].filter((t) => !original.has(t)).sort();
  return {
    dimension,
    kind: "measured",
    summary: `${matched.length}/${original.size} reproduced in the reconstruction${extra.length ? `, ${extra.length} extra` : ""}.`,
    score: matched.length / original.size,
    detail: [...missing.map((m) => `missing: ${m}`), ...extra.map((e) => `extra: ${e}`)],
  };
}

function compareArchitecture(originalComponents: Set<string>, reconComponents: Set<string>): CompareRow {
  if (originalComponents.size === 0 && reconComponents.size === 0) {
    return { dimension: "Architecture similarity", kind: "not-measurable", summary: "Neither side has extracted components to compare.", score: null };
  }
  const union = new Set([...originalComponents, ...reconComponents]);
  const intersection = [...originalComponents].filter((c) => reconComponents.has(c));
  const score = union.size === 0 ? 0 : intersection.length / union.size;
  return {
    dimension: "Architecture similarity",
    kind: "heuristic",
    summary: `Jaccard similarity of component-directory sets: ${Math.round(score * 100)}%. Heuristic, not a structural/behavioral comparison.`,
    score,
  };
}

function runNpmScript(reconRoot: string, script: "build" | "test"): { ok: boolean; output: string } {
  try {
    const output = execFileSync("npm", ["run", script], { cwd: reconRoot, stdio: "pipe", timeout: 120_000, encoding: "utf8" });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: (e.stderr || e.stdout || e.message || "").toString() };
  }
}

function compareExecuted(dimension: string, scriptKey: "build" | "test", originalHasScript: boolean, runBuild: boolean, reconRoot: string): CompareRow {
  if (!originalHasScript) {
    return { dimension, kind: "not-measurable", summary: `The original has no known \`${scriptKey}\` script (package.json).`, score: null };
  }
  if (!runBuild) {
    return { dimension, kind: "not-measurable", summary: `Not run — pass --run-build to execute \`npm run ${scriptKey}\` in the reconstruction (this runs real code from the reconstruction repo).`, score: null };
  }
  const result = runNpmScript(reconRoot, scriptKey);
  return {
    dimension,
    kind: "measured",
    summary: `\`npm run ${scriptKey}\` ${result.ok ? "succeeded" : "failed"} in the reconstruction.`,
    score: result.ok ? 1 : 0,
    detail: result.ok ? undefined : [result.output.slice(0, 500)],
  };
}

export function runCompare(options: CompareOptions): CompareResult {
  const { manifest, nodes: originalNodes } = loadPkr(options.originalPkrDir);

  const reconRoot = path.resolve(options.reconstructionRepoDir);
  if (!fs.existsSync(reconRoot) || !fs.statSync(reconRoot).isDirectory()) {
    throw new Error(`Not a directory: ${reconRoot}`);
  }

  // Fresh deterministic extraction against the *candidate* — a throwaway
  // scratch allocator, same pattern as `pkr update`'s own re-extraction
  // pass (update/index.ts): these IDs are never persisted, only used to
  // build comparable node sets for this one comparison.
  const inventory = buildInventory(reconRoot);
  const scratchAllocator = IdAllocator.load(path.join(os.tmpdir(), `pkr-compare-scratch-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  const reconApiNodes = analyzeApiEndpoints(reconRoot, inventory, scratchAllocator, "reconstruction");
  const reconDbNodes = analyzeDatabaseSchema(reconRoot, inventory, scratchAllocator, "reconstruction");
  const reconStructureNodes = analyzeStructure(inventory, scratchAllocator, "reconstruction");

  const rows: CompareRow[] = [
    compareSets("API compatibility", titleSet(originalNodes, "api-endpoint"), titleSet(reconApiNodes, "api-endpoint")),
    compareSets("Schema compatibility", titleSet(originalNodes, "db-table"), titleSet(reconDbNodes, "db-table")),
    compareArchitecture(titleSet(originalNodes, "component"), titleSet(reconStructureNodes, "component")),
    compareExecuted("Build success", "build", Boolean(manifest.validation?.commands?.build), options.runBuild ?? false, reconRoot),
    compareExecuted("Test success", "test", Boolean(manifest.validation?.commands?.test), options.runBuild ?? false, reconRoot),
  ];

  const scoredRows = rows.filter((r): r is CompareRow & { score: number } => r.score !== null);
  const weight = scoredRows.length > 0 ? 1 / scoredRows.length : 0;
  const weights: Record<string, number> = {};
  for (const r of scoredRows) weights[r.dimension] = weight;
  const overallScore = scoredRows.length > 0 ? scoredRows.reduce((sum, r) => sum + r.score * weight, 0) : null;

  return { rows, overallScore, weights };
}
