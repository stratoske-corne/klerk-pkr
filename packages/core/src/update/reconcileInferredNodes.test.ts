import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IdAllocator } from "../ids.js";
import { makeInferredNode } from "../node-factory.js";
import { FileNodeStore } from "../store/fileNodeStore.js";
import { reconcileInferredNodes } from "./reconcileInferredNodes.js";
import type { KnowledgeNode } from "../types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-reconcile-"));
}

function makeOldNode(allocator: IdAllocator, overrides: Partial<KnowledgeNode> = {}): KnowledgeNode {
  const node = makeInferredNode(allocator, "proj", "POINTS", {
    type: "business-rule",
    title: "VIP 2x multiplier applies only to purchase-earned points",
    content: "Accounts with lifetimeSpendCents >= $500 get a 2x multiplier...",
    confidence: 0.9,
    evidence: [{ path: "src/services/pointsService.js" }],
  });
  return { ...node, ...overrides };
}

function makeNewNode(allocator: IdAllocator, supersedes: string | null = null): KnowledgeNode {
  return makeInferredNode(allocator, "proj", "POINTS", {
    type: "business-rule",
    title: "VIP 2x multiplier applies only to purchase-earned points",
    content: "Accounts with lifetime spend >= $1,000 get a 2x multiplier...",
    confidence: 0.85,
    evidence: [{ path: "src/services/pointsService.js" }],
    supersedes,
  });
}

describe("reconcileInferredNodes", () => {
  let dir: string;
  let allocator: IdAllocator;
  let store: FileNodeStore;

  beforeEach(() => {
    dir = tmpDir();
    allocator = IdAllocator.load(dir);
    store = FileNodeStore.load(dir);
  });

  it("creates a supersedes edge and keeps the (non-confirmed) target in the store, untouched", () => {
    const oldNode = makeOldNode(allocator);
    store.upsertNode(oldNode);

    const newNode = makeNewNode(allocator, oldNode.id);
    store.upsertNode(newNode);

    const report = reconcileInferredNodes(store, "proj", [newNode], [{ nodeId: newNode.id, targets: [oldNode.id] }]);

    expect(report.superseded).toHaveLength(1);
    expect(report.superseded[0]).toMatchObject({ newNode: { id: newNode.id }, target: { id: oldNode.id } });
    expect(report.conflicts).toHaveLength(0);

    // Target is untouched, still in the store.
    expect(store.getNode(oldNode.id)).toEqual(oldNode);

    const edges = store.listEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source_node: newNode.id,
      target_node: oldNode.id,
      relationship_type: "supersedes",
    });
  });

  it("REGRESSION: routes a confirmed target to conflicts_with instead of supersedes — never hidden or touched", () => {
    const oldNode = makeOldNode(allocator, { status: "confirmed", confidence: null, confirmed_by: "human" });
    store.upsertNode(oldNode);

    const newNode = makeNewNode(allocator, oldNode.id);
    store.upsertNode(newNode);

    const report = reconcileInferredNodes(store, "proj", [newNode], [{ nodeId: newNode.id, targets: [oldNode.id] }]);

    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]).toMatchObject({ newNode: { id: newNode.id }, target: { id: oldNode.id } });
    expect(report.superseded).toHaveLength(0);

    // Confirmed target is completely untouched — same guarantee as mergeNodes.ts.
    expect(store.getNode(oldNode.id)).toEqual(oldNode);

    const edges = store.listEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship_type).toBe("conflicts_with");
  });

  it("handles multiple targets from the same claim, splitting confirmed and non-confirmed correctly", () => {
    const confirmedOld = makeOldNode(allocator, { status: "confirmed", confidence: null, confirmed_by: "human" });
    const plainOld = makeOldNode(allocator, { title: "A different old rule" });
    store.upsertNode(confirmedOld);
    store.upsertNode(plainOld);

    const newNode = makeNewNode(allocator);
    store.upsertNode(newNode);

    const report = reconcileInferredNodes(store, "proj", [newNode], [
      { nodeId: newNode.id, targets: [confirmedOld.id, plainOld.id] },
    ]);

    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].target.id).toBe(confirmedOld.id);
    expect(report.superseded).toHaveLength(1);
    expect(report.superseded[0].target.id).toBe(plainOld.id);
  });

  it("is a no-op when there are no claims", () => {
    const report = reconcileInferredNodes(store, "proj", [], []);
    expect(report.superseded).toHaveLength(0);
    expect(report.conflicts).toHaveLength(0);
    expect(store.listEdges()).toHaveLength(0);
  });

  it("skips a claim whose target ID doesn't exist in the store, without throwing", () => {
    const newNode = makeNewNode(allocator, "RULE-DOES-NOT-EXIST");
    store.upsertNode(newNode);

    const report = reconcileInferredNodes(store, "proj", [newNode], [
      { nodeId: newNode.id, targets: ["RULE-DOES-NOT-EXIST"] },
    ]);

    expect(report.superseded).toHaveLength(0);
    expect(report.conflicts).toHaveLength(0);
    expect(store.listEdges()).toHaveLength(0);
  });
});
