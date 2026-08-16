/**
 * `pkr update` — incremental re-sync. ARCHITECTURE.md §2 (incremental
 * update) / §17 (why this matters more than `pkr reconstruct` in practice).
 *
 * Unlike `pkr export` (always a full clean regeneration, PRODUCT_SPEC.md
 * §4), this loads the *existing* PKR and merges fresh facts into it,
 * preserving node IDs and confirmed knowledge (PKR_SPEC.md §4.2).
 *
 * Scope of "incremental" in this slice: correctness, not performance.
 * Deterministic re-extraction (stages 2-4) always runs in full against the
 * current repo state — cheap, no LLM — then gets *diffed* against the
 * stored graph so only genuinely changed facts move. What's scoped is the
 * *output* (a semantic diff, not a full re-render narrated as new), not the
 * extraction work itself. True partial/scoped extraction is a possible
 * future optimization (ARCHITECTURE.md §2), not required for this to be
 * correct.
 *
 * Stage 6 on update used to be purely additive — newly proposed inferred
 * nodes were added; existing ones were never touched, which shipped a real,
 * visible bug (ARCHITECTURE.md §16 Run 4: a corrected fact and the stale
 * fact it replaced ended up side by side in the same rendered file, actively
 * contradicting each other). Reconciliation (ARCHITECTURE.md §19) fixes
 * this: stage 6 is shown the current inferred nodes and can mark ones it
 * replaces via `supersedes`; `reconcileInferredNodes.ts` turns that into
 * real edges, and `render.ts` keeps a stale fact out of the main files
 * (into `superseded.md` instead) without ever deleting it. Still
 * conservative by design: nothing is retired without the model positively
 * saying so this call — see reconcileInferredNodes.ts's module doc.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { IdAllocator } from "../ids.js";
import { FileNodeStore } from "../store/fileNodeStore.js";
import { buildInventory, saveInventory, loadInventory } from "../extract/inventory.js";
import { analyzeDependencies } from "../extract/dependencies.js";
import { analyzeStructure } from "../extract/structure.js";
import { analyzeApiEndpoints, analyzeDatabaseSchema, analyzeExternalServices } from "../extract/interfaces.js";
import { synthesizeProductAndBehavior, type SkippedSynthesisNode, type WeaklyGroundedNode } from "../extract/synthesize.js";
import { renderProjectKnowledge } from "../render/render.js";
import { diffInventory, hasChanges, type InventoryDiff } from "./diffInventory.js";
import { mergeDeterministicNodes, type NodeMergeReport } from "./mergeNodes.js";
import { reconcileInferredNodes, type InferredReconcileReport } from "./reconcileInferredNodes.js";
import type { LlmClient } from "../llm/client.js";
import type { KnowledgeNode } from "../types.js";

export interface UpdateOptions {
  repoRoot: string;
  outDir?: string;
  projectId?: string;
  llm?: LlmClient | null;
}

export interface LlmUpdateReport {
  ranSuccessfully: boolean;
  added: KnowledgeNode[];
  skipped: SkippedSynthesisNode[];
  weaklyGrounded: WeaklyGroundedNode[];
  /** ARCHITECTURE.md §19 — non-confirmed prior nodes this call replaced (edges created, target kept but excluded from the main rendered files). */
  superseded: InferredReconcileReport["superseded"];
  /** ARCHITECTURE.md §19 — confirmed prior nodes a new node contradicted (edges created, target completely untouched, needs a human). */
  conflicts: InferredReconcileReport["conflicts"];
  error?: string;
}

export interface UpdateResult {
  outDir: string;
  upToDate: boolean;
  fileDiff: InventoryDiff;
  nodeMerge: NodeMergeReport | null;
  llm: LlmUpdateReport | null;
  achievedLevel: number | null;
  writtenFiles: string[];
}

const GENERATOR_VERSION = "pkr-cli@0.1.0";

function detectGitCommit(repoRoot: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export async function runUpdate(options: UpdateOptions): Promise<UpdateResult> {
  const repoRoot = path.resolve(options.repoRoot);
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throw new Error(`Not a directory: ${repoRoot}`);
  }

  const outDir = options.outDir ?? path.join(repoRoot, ".projectknowledge");
  const knowledgeDir = path.join(outDir, ".knowledge");
  const projectId = options.projectId ?? path.basename(repoRoot);

  if (!fs.existsSync(path.join(outDir, "manifest.yaml"))) {
    throw new Error(`No existing PKR at ${outDir} — run \`pkr export\` (or \`pkr init\`) first.`);
  }

  const previousInventory = loadInventory(knowledgeDir); // null if this PKR predates inventory persistence
  const freshInventory = buildInventory(repoRoot);
  const fileDiff = diffInventory(previousInventory ?? [], freshInventory.files);

  if (previousInventory !== null && !hasChanges(fileDiff)) {
    return {
      outDir,
      upToDate: true,
      fileDiff,
      nodeMerge: null,
      llm: null,
      achievedLevel: null,
      writtenFiles: [],
    };
  }

  const allocator = IdAllocator.load(knowledgeDir);
  const store = FileNodeStore.load(knowledgeDir);

  // Throwaway allocator for the fresh extraction pass — its IDs are never
  // persisted; mergeDeterministicNodes decides which ones become real.
  const scratchAllocator = IdAllocator.load(path.join(knowledgeDir, `.scratch-${Date.now()}`));

  const depResult = analyzeDependencies(repoRoot, scratchAllocator, projectId);
  const structureNodes = analyzeStructure(freshInventory, scratchAllocator, projectId);
  const apiNodes = analyzeApiEndpoints(repoRoot, freshInventory, scratchAllocator, projectId);
  const dbNodes = analyzeDatabaseSchema(repoRoot, freshInventory, scratchAllocator, projectId);
  const externalServiceNodes = analyzeExternalServices(depResult.dependencyNames, scratchAllocator, projectId);
  const candidates = [...depResult.nodes, ...structureNodes, ...apiNodes, ...dbNodes, ...externalServiceNodes];

  const nodeMerge = mergeDeterministicNodes(store, allocator, projectId, candidates);

  let llmReport: LlmUpdateReport | null = null;
  if (options.llm) {
    try {
      const projectName = depResult.projectName ?? projectId;
      // Split what's already in the store: deterministic facts are
      // "observed_facts" material same as always; existing *inferred* nodes
      // are what reconciliation (ARCHITECTURE.md §19) needs shown separately
      // so the model can recognize when a new fact updates one of them,
      // rather than getting folded into the generic observed-facts summary.
      const storeNodes = store.listNodes();
      const deterministicNodes = storeNodes.filter((n) => n.status !== "inferred");
      const existingInferredNodes = storeNodes.filter((n) => n.status === "inferred");
      // ARCHITECTURE.md §20 M7 — give stage 6 top excerpt priority over
      // exactly the files this update is actually about, instead of letting
      // it re-run a generic "orient a stranger" selection blind to what the
      // diff already knows changed.
      const changedFiles = [...fileDiff.added, ...fileDiff.modified];

      const result = await synthesizeProductAndBehavior(
        repoRoot,
        freshInventory,
        deterministicNodes,
        projectId,
        projectName,
        depResult.projectDescription,
        allocator,
        options.llm,
        existingInferredNodes,
        changedFiles,
      );
      for (const node of result.nodes) store.upsertNode(node);
      const reconcile = reconcileInferredNodes(store, projectId, result.nodes, result.supersedesClaims);
      llmReport = {
        ranSuccessfully: true,
        added: result.nodes,
        skipped: result.skipped,
        weaklyGrounded: result.weaklyGrounded,
        superseded: reconcile.superseded,
        conflicts: reconcile.conflicts,
      };
    } catch (err) {
      llmReport = { ranSuccessfully: false, added: [], skipped: [], weaklyGrounded: [], superseded: [], conflicts: [], error: (err as Error).message };
    }
  }

  // ARCHITECTURE.md §16 Run 4 process finding, fixed here: if stage 6 was
  // requested and failed, don't advance the inventory baseline. Previously
  // this saved unconditionally, so a transient LLM failure (rate limit,
  // network, overload) permanently forfeited that update's semantic-layer
  // sync — the next `pkr update --llm` run would recompute the same
  // (now-baselined) file diff as empty and short-circuit as "up to date"
  // above, silently never re-attempting stage 6 unless something else
  // changed first. Deterministic results are saved either way (below):
  // re-running `mergeDeterministicNodes` against an already-merged store on
  // a retry is a safe no-op (natural-key matching sees those facts as
  // already up to date), so there's no cost to keeping them.
  const llmFailed = options.llm != null && llmReport?.ranSuccessfully === false;

  allocator.save();
  store.save();
  if (!llmFailed) {
    saveInventory(knowledgeDir, freshInventory);
  }

  const projectName = depResult.projectName ?? projectId;
  const renderResult = renderProjectKnowledge({
    outDir,
    projectName,
    projectDescription: depResult.projectDescription,
    nodes: store.listNodes(),
    edges: store.listEdges(),
    sourceCommit: detectGitCommit(repoRoot),
    generatorVersion: GENERATOR_VERSION,
    knowledgeVersion: "v0.1", // real Knowledge Versioning (PKR_SPEC.md §7) isn't built yet — see ARCHITECTURE.md §0
    validationCommands: Object.keys(depResult.validationCommands).length > 0 ? depResult.validationCommands : undefined,
  });

  return {
    outDir,
    upToDate: false,
    fileDiff,
    nodeMerge,
    llm: llmReport,
    achievedLevel: renderResult.achievedLevel,
    writtenFiles: renderResult.writtenFiles,
  };
}
