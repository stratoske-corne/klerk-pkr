/**
 * Stage 4 — Structure analysis. ARCHITECTURE.md §2 stage 4.
 *
 * Derives `component` and `convention` nodes purely from directory layout
 * and file classification already computed in stage 1 (inventory.ts) — no
 * file content is read here beyond what stage 1 already read, and no
 * judgment calls are made, so every node is `status: observed`.
 */

import * as path from "node:path";
import type { IdAllocator } from "../ids.js";
import { makeNode } from "../node-factory.js";
import type { KnowledgeNode } from "../types.js";
import type { Inventory, InventoryFile } from "./inventory.js";

function topLevelSegment(relPath: string): string | null {
  const idx = relPath.indexOf("/");
  return idx === -1 ? null : relPath.slice(0, idx);
}

export function analyzeStructure(
  inventory: Inventory,
  allocator: IdAllocator,
  projectId: string,
): KnowledgeNode[] {
  const nodes: KnowledgeNode[] = [];

  // --- top-level directories with source files -> component nodes -------
  const byTopDir = new Map<string, InventoryFile[]>();
  for (const file of inventory.files) {
    const top = topLevelSegment(file.path);
    if (!top) continue;
    if (!byTopDir.has(top)) byTopDir.set(top, []);
    byTopDir.get(top)!.push(file);
  }

  const componentDirs = [...byTopDir.entries()]
    .filter(([, files]) => files.some((f) => f.kind === "source"))
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [dir, files] of componentDirs) {
    const sourceCount = files.filter((f) => f.kind === "source").length;
    const testCount = files.filter((f) => f.kind === "test").length;
    nodes.push(
      makeNode(allocator, projectId, "STRUCT", {
        type: "component",
        title: `${dir}/`,
        content:
          `Top-level directory \`${dir}/\` contains ${sourceCount} source file(s)` +
          (testCount ? ` and ${testCount} test file(s)` : "") +
          `. Component boundary inferred from directory structure only — no internal dependency analysis performed yet.`,
        status: "observed",
        confidence: null,
        evidence: [{ path: `${dir}/` }],
      }),
    );
  }

  // --- monorepo / workspace convention -----------------------------------
  const workspaceRoots = ["packages", "apps", "services"].filter((d) => byTopDir.has(d));
  if (workspaceRoots.length > 0) {
    nodes.push(
      makeNode(allocator, projectId, "STRUCT", {
        type: "convention",
        title: "Monorepo / workspace layout",
        content:
          `The repository groups code under ${workspaceRoots.map((d) => `\`${d}/\``).join(", ")}, ` +
          `consistent with a multi-package workspace layout rather than a single flat package.`,
        status: "observed",
        confidence: null,
        evidence: workspaceRoots.map((d) => ({ path: `${d}/` })),
      }),
    );
  }

  // --- test co-location convention ---------------------------------------
  const testFiles = inventory.files.filter((f) => f.kind === "test");
  if (testFiles.length > 0) {
    const dedicatedTestDirRe = /(^|\/)(__tests__|tests?|spec)(\/)/i;
    const dedicated = testFiles.filter((f) => dedicatedTestDirRe.test(f.path)).length;
    const colocated = testFiles.length - dedicated;
    const dominant = colocated >= dedicated ? "colocated" : "dedicated-directory";
    nodes.push(
      makeNode(allocator, projectId, "STRUCT", {
        type: "convention",
        title: dominant === "colocated" ? "Tests colocated with source" : "Tests in a dedicated directory",
        content:
          dominant === "colocated"
            ? `${colocated} of ${testFiles.length} test files live next to the source file they test, rather than in a separate test directory.`
            : `${dedicated} of ${testFiles.length} test files live under a dedicated test directory (e.g. \`tests/\`, \`__tests__/\`) rather than beside their source file.`,
        status: "observed",
        confidence: null,
        evidence: testFiles.slice(0, 5).map((f) => ({ path: f.path })),
      }),
    );
  }

  return nodes;
}
