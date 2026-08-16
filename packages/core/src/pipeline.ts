/**
 * Orchestrates `pkr export`: stages 1, 2, 3, 4, 6, 7 (ARCHITECTURE.md §2).
 * Stage 5 (test/env analysis) is not implemented yet — see ARCHITECTURE.md
 * §9, "smallest possible vertical slice". This function is the seam where
 * it'll be added.
 *
 * `pkr export` always does a full, clean regeneration — it is the *initial
 * import* step (PRODUCT_SPEC.md §4). Incremental, confirmation-preserving
 * re-analysis is `pkr update`'s job and is not built yet (ARCHITECTURE.md
 * M6+ groundwork; the store/ID-allocator design already supports it).
 *
 * Stage 6 (LLM synthesis) is optional and skips gracefully: no configured
 * LLM client means `product/` and `behavior/` stay empty and the achieved
 * reconstruction level stays low, but the deterministic stages still run
 * and the export still succeeds — a missing API key is never a hard failure.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { IdAllocator } from "./ids.js";
import { FileNodeStore } from "./store/fileNodeStore.js";
import { buildInventory, saveInventory } from "./extract/inventory.js";
import { analyzeDependencies } from "./extract/dependencies.js";
import { analyzeStructure } from "./extract/structure.js";
import { analyzeApiEndpoints, analyzeDatabaseSchema, analyzeExternalServices, analyzeEvents } from "./extract/interfaces.js";
import { analyzeEnvironment } from "./extract/environment.js";
import { synthesizeProductAndBehavior, type SkippedSynthesisNode, type WeaklyGroundedNode } from "./extract/synthesize.js";
import { renderProjectKnowledge } from "./render/render.js";
import { commitVersion, summarizeChanges, type ChangedNode } from "./versions.js";
import type { LlmClient } from "./llm/client.js";

export interface ExportOptions {
  repoRoot: string;
  outDir?: string;
  projectId?: string;
  /** Pass a client to run stage 6 (LLM synthesis); omit/null to skip it. */
  llm?: LlmClient | null;
}

export interface SynthesisReport {
  ranSuccessfully: boolean;
  nodeCount: number;
  skipped: SkippedSynthesisNode[];
  excerptFiles: string[];
  /** Secret-shaped values redacted from excerpt content before it left this machine as part of the LLM API call — see synthesize.ts's SynthesisResult doc. */
  excerptRedactions: number;
  /** Accepted nodes whose evidence never included a file the model actually read (excerpt content) — see extract/synthesize.ts's WeaklyGroundedNode doc. */
  weaklyGrounded: WeaklyGroundedNode[];
  error?: string;
}

export interface ExportResult {
  outDir: string;
  writtenFiles: string[];
  nodeCount: number;
  edgeCount: number;
  achievedLevel: number;
  totalRedactions: number;
  synthesis: SynthesisReport | null;
  /** ARCHITECTURE.md §24 — always "v0.1" on a fresh export, since it's always a clean rebuild. Null only if the store somehow ended up with zero nodes. */
  knowledgeVersion: string | null;
}

function detectGitCommit(repoRoot: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const GENERATOR_VERSION = "pkr-cli@0.1.0";

export async function runExport(options: ExportOptions): Promise<ExportResult> {
  const repoRoot = path.resolve(options.repoRoot);
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throw new Error(`Not a directory: ${repoRoot}`);
  }

  const outDir = options.outDir ?? path.join(repoRoot, ".projectknowledge");
  const knowledgeDir = path.join(outDir, ".knowledge");
  const projectId = options.projectId ?? path.basename(repoRoot);

  // `pkr export` is a clean regeneration (see module doc). Wipe any prior
  // output first so IDs and rendered files don't accumulate stale state.
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  const allocator = IdAllocator.load(knowledgeDir);
  const store = FileNodeStore.load(knowledgeDir);

  const inventory = buildInventory(repoRoot);
  saveInventory(knowledgeDir, inventory); // baseline for the next `pkr update`

  const depResult = analyzeDependencies(repoRoot, allocator, projectId);
  const structureNodes = analyzeStructure(inventory, allocator, projectId);
  const apiNodes = analyzeApiEndpoints(repoRoot, inventory, allocator, projectId);
  const dbNodes = analyzeDatabaseSchema(repoRoot, inventory, allocator, projectId);
  const externalServiceNodes = analyzeExternalServices(depResult.dependencyNames, allocator, projectId);
  const eventNodes = analyzeEvents(repoRoot, inventory, allocator, projectId);
  const environmentNodes = analyzeEnvironment(repoRoot, inventory, allocator, projectId);

  const deterministicNodes = [
    ...depResult.nodes,
    ...structureNodes,
    ...apiNodes,
    ...dbNodes,
    ...externalServiceNodes,
    ...eventNodes,
    ...environmentNodes,
  ];
  for (const node of deterministicNodes) {
    store.upsertNode(node);
  }

  const projectName = depResult.projectName ?? projectId;

  let synthesis: SynthesisReport | null = null;
  if (options.llm) {
    try {
      const result = await synthesizeProductAndBehavior(
        repoRoot,
        inventory,
        deterministicNodes,
        projectId,
        projectName,
        depResult.projectDescription,
        allocator,
        options.llm,
      );
      for (const node of result.nodes) store.upsertNode(node);
      synthesis = {
        ranSuccessfully: true,
        nodeCount: result.nodes.length,
        skipped: result.skipped,
        excerptFiles: result.excerptFiles,
        excerptRedactions: result.excerptRedactions,
        weaklyGrounded: result.weaklyGrounded,
      };
    } catch (err) {
      synthesis = {
        ranSuccessfully: false,
        nodeCount: 0,
        skipped: [],
        excerptFiles: [],
        excerptRedactions: 0,
        weaklyGrounded: [],
        error: (err as Error).message,
      };
    }
  }

  allocator.save();
  store.save();

  // Knowledge Versioning (PKR_SPEC.md §7 / ARCHITECTURE.md §24 — auto-commit
  // MVP). `pkr export` always wipes and rebuilds from scratch (module doc
  // above), so every node it produces is genuinely new for this PKR's
  // history: v0.1, unconditionally, no parent.
  const sourceCommit = detectGitCommit(repoRoot);
  const changedNodes: ChangedNode[] = store.listNodes().map((n) => ({ id: n.id, change: "added" as const }));
  const knowledgeVersion = commitVersion(knowledgeDir, {
    summary: `Initial export: ${summarizeChanges(changedNodes)}`,
    changedNodes,
    sourceCommit,
  });

  const renderResult = renderProjectKnowledge({
    outDir,
    projectName,
    projectDescription: depResult.projectDescription,
    nodes: store.listNodes(),
    edges: store.listEdges(),
    sourceCommit,
    generatorVersion: GENERATOR_VERSION,
    knowledgeVersion: knowledgeVersion ?? "v0.1", // null only if the store somehow has zero nodes
    validationCommands: Object.keys(depResult.validationCommands).length > 0 ? depResult.validationCommands : undefined,
  });

  return {
    outDir,
    writtenFiles: renderResult.writtenFiles,
    nodeCount: store.listNodes().length,
    edgeCount: store.listEdges().length,
    achievedLevel: renderResult.achievedLevel,
    totalRedactions: renderResult.totalRedactions,
    synthesis,
    knowledgeVersion,
  };
}
