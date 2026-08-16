import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IdAllocator } from "../ids.js";
import { makeNode } from "../node-factory.js";
import { FileNodeStore } from "../store/fileNodeStore.js";
import { mergeDeterministicNodes } from "./mergeNodes.js";
import type { KnowledgeNode } from "../types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-merge-"));
}

/** Candidates come from a throwaway allocator in the real pipeline (update/index.ts) — mirror that here. */
function candidateAllocator(): IdAllocator {
  return IdAllocator.load(tmpDir());
}

function dep(allocator: IdAllocator, name: string, version: string): KnowledgeNode {
  return makeNode(allocator, "proj", "DEPS", {
    type: "dependency",
    title: `${name} (${version})`,
    content: `${name} is a runtime dependency, declared in package.json with version range \`${version}\`.`,
    status: "observed",
    confidence: null,
    evidence: [{ path: "package.json" }],
  });
}

describe("mergeDeterministicNodes", () => {
  let dir: string;
  let allocator: IdAllocator; // the REAL allocator, backing the store
  let store: FileNodeStore;

  beforeEach(() => {
    dir = tmpDir();
    allocator = IdAllocator.load(dir);
    store = FileNodeStore.load(dir);
  });

  it("adds a genuinely new fact under a freshly allocated real ID", () => {
    const candidates = [dep(candidateAllocator(), "zod", "^3.23.8")];
    const report = mergeDeterministicNodes(store, allocator, "proj", candidates);

    expect(report.added).toHaveLength(1);
    expect(report.added[0].id).toMatch(/^TECH-DEPS-\d{3}$/);
    expect(report.modified).toHaveLength(0);
    expect(store.getNode(report.added[0].id)?.title).toBe("zod (^3.23.8)");
  });

  it("is a no-op (unchanged) when re-extraction reproduces the exact same fact", () => {
    const existing = dep(allocator, "zod", "^3.23.8");
    store.upsertNode(existing);

    const candidates = [dep(candidateAllocator(), "zod", "^3.23.8")];
    const report = mergeDeterministicNodes(store, allocator, "proj", candidates);

    expect(report.added).toHaveLength(0);
    expect(report.modified).toHaveLength(0);
    expect(report.unchangedCount).toBe(1);
    expect(store.getNode(existing.id)).toEqual(existing); // byte-for-byte untouched
  });

  it("keeps the existing ID and merges in place when content changed (e.g. a version bump)", () => {
    const existing = dep(allocator, "zod", "^3.23.8");
    store.upsertNode(existing);

    const candidates = [dep(candidateAllocator(), "zod", "^3.24.0")];
    const report = mergeDeterministicNodes(store, allocator, "proj", candidates);

    expect(report.modified).toHaveLength(1);
    expect(report.modified[0].after.id).toBe(existing.id); // same natural key -> same stable ID
    expect(report.modified[0].after.title).toBe("zod (^3.24.0)");
    expect(store.getNode(existing.id)?.title).toBe("zod (^3.24.0)");
  });

  it("removes a fact whose file disappeared (e.g. a dependency was dropped) when it was never confirmed", () => {
    const existing = dep(allocator, "left-pad", "^1.0.0");
    store.upsertNode(existing);

    const report = mergeDeterministicNodes(store, allocator, "proj", []); // left-pad no longer re-extracted

    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].id).toBe(existing.id);
    expect(store.getNode(existing.id)).toBeUndefined();
  });

  it("REGRESSION: never silently overwrites a confirmed node's content — routes to a conflict instead (the bug found and fixed this session)", () => {
    const original = dep(allocator, "zod", "^3.23.8");
    const confirmed: KnowledgeNode = { ...original, status: "confirmed", confidence: null, confirmed_by: "human" };
    store.upsertNode(confirmed);

    const candidates = [dep(candidateAllocator(), "zod", "^3.24.0")]; // extraction now disagrees
    const report = mergeDeterministicNodes(store, allocator, "proj", candidates);

    // The confirmed node itself must be completely untouched.
    expect(store.getNode(confirmed.id)).toEqual(confirmed);
    expect(report.modified).toHaveLength(0);

    // A separate conflicting node was created instead, linked by a conflicts_with edge.
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].existing.id).toBe(confirmed.id);
    const conflictNode = report.conflicts[0].candidate;
    expect(conflictNode.id).not.toBe(confirmed.id);
    expect(conflictNode.title).toBe("zod (^3.24.0)");
    expect(conflictNode.status).toBe("observed"); // fresh extraction's own status, not leaked from `confirmed`
    expect(conflictNode.confirmed_by).toBeNull(); // must NOT inherit "human" from the confirmed node

    const edges = store.listEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source_node: conflictNode.id,
      target_node: confirmed.id,
      relationship_type: "conflicts_with",
    });
  });

  it("REGRESSION: a confirmed node that no longer re-extracts at all is surfaced as a conflict, never auto-deleted", () => {
    const original = dep(allocator, "left-pad", "^1.0.0");
    const confirmed: KnowledgeNode = { ...original, status: "confirmed", confidence: null, confirmed_by: "human" };
    store.upsertNode(confirmed);

    const report = mergeDeterministicNodes(store, allocator, "proj", []); // left-pad vanished from package.json

    expect(report.removed).toHaveLength(0);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].existing.id).toBe(confirmed.id);
    expect(store.getNode(confirmed.id)).toEqual(confirmed); // still there
  });

  // Found via a real performance review (ARCHITECTURE.md §31), not a
  // hypothetical: natural-key matching used `oldNodes.find(...)` inside the
  // per-candidate loop, an O(candidates * existing-nodes) scan. Measured
  // super-linear at real scale before the fix (10x the nodes -> ~70x the
  // time in a standalone 10k-node benchmark, not 10x). Fixed by indexing
  // old nodes into a Map<naturalKey, node> once (O(n)) instead of scanning
  // per candidate. This test can't reproduce a multi-hundred-ms difference
  // reliably in CI, so it asserts the *shape* of the scaling (an 8x node
  // count should cost nowhere near 8x-squared time), not an absolute bound.
  it("PERFORMANCE REGRESSION: matches candidates against the existing node set in roughly linear time, not quadratic", () => {
    function apiNode(alloc: IdAllocator, i: number): KnowledgeNode {
      return makeNode(alloc, "proj", "HTTP", {
        type: "api-endpoint",
        title: `GET /route/${i}`,
        content: `HTTP GET handler for /route/${i}.`,
        status: "observed",
        confidence: null,
        evidence: [{ path: `src/route${i}.js`, lines: [1, 1] }],
      });
    }

    function timeMergeOf(n: number): number {
      const dir2 = tmpDir();
      const seedAlloc = IdAllocator.load(dir2);
      const seedStore = FileNodeStore.load(dir2);
      for (let i = 0; i < n; i++) seedStore.upsertNode(apiNode(seedAlloc, i));
      seedStore.save();
      seedAlloc.save();

      const candidates: KnowledgeNode[] = [];
      const candAlloc = candidateAllocator();
      for (let i = 0; i < n; i++) candidates.push(apiNode(candAlloc, i)); // identical content -> the worst case for a linear-scan match: every candidate matches, none short-circuit early on a miss

      const freshStore = FileNodeStore.load(dir2);
      const freshAlloc = IdAllocator.load(dir2);
      const start = performance.now();
      mergeDeterministicNodes(freshStore, freshAlloc, "proj", candidates);
      return performance.now() - start;
    }

    const small = timeMergeOf(2000);
    const large = timeMergeOf(16000); // 8x the node count

    // Linear -> ~8x. Quadratic -> ~64x. Generous slack for CI noise/GC
    // without letting a real regression to O(n^2) hide: a +200ms floor
    // keeps a near-zero `small` measurement from making the ratio
    // meaningless, and 20x is comfortably below 64x but well above 8x.
    // Sizes tuned by hand against the actual old/new implementations (not
    // guessed): 500/4000 measured 3.5ms/108.9ms pre-fix — the 20x+200ms
    // budget (270ms) didn't discriminate at that scale, all noise/floor.
    // 2000/16000 measured 30.5ms/1045ms pre-fix (fails an 810ms budget, as
    // it should) and 4.8ms/36.4ms post-fix (comfortably passes).
    expect(large).toBeLessThan(small * 20 + 200);
  });
});
