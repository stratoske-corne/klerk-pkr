/**
 * Covers the `superseded.md` mechanism added for ARCHITECTURE.md §19: a
 * node that's the target of a `supersedes` edge should disappear from its
 * normal section file (so a stale and a corrected fact don't sit side by
 * side, §16 Run 4's actual bug) but still be readable somewhere, since
 * PKR_SPEC.md §8 promises the rendered Markdown alone is portable.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IdAllocator } from "../ids.js";
import { makeNode } from "../node-factory.js";
import { renderProjectKnowledge } from "./render.js";
import type { KnowledgeEdge, KnowledgeNode } from "../types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-render-"));
}

function supersedesEdge(sourceId: string, targetId: string): KnowledgeEdge {
  return {
    id: `${sourceId}--supersedes--${targetId}`,
    project_id: "proj",
    source_node: sourceId,
    target_node: targetId,
    relationship_type: "supersedes",
    created_at: new Date().toISOString(),
  };
}

describe("renderProjectKnowledge — superseded nodes", () => {
  let allocator: IdAllocator;
  let outDir: string;

  beforeEach(() => {
    allocator = IdAllocator.load(tmpDir());
    outDir = path.join(tmpDir(), ".projectknowledge");
  });

  function makeRule(title: string, content: string): KnowledgeNode {
    return makeNode(allocator, "proj", "POINTS", {
      type: "business-rule",
      title,
      content,
      status: "inferred",
      confidence: 0.85,
      evidence: [{ path: "src/services/pointsService.js" }],
    });
  }

  it("excludes a non-confirmed superseded node from its normal section file, and lists it in superseded.md instead", () => {
    const oldNode = makeRule("VIP multiplier threshold", "Threshold is $500.");
    const newNode = { ...makeRule("VIP multiplier threshold", "Threshold is $1,000."), supersedes: oldNode.id };

    renderProjectKnowledge({
      outDir,
      projectName: "demo",
      nodes: [oldNode, newNode],
      edges: [supersedesEdge(newNode.id, oldNode.id)],
      sourceCommit: null,
      generatorVersion: "test",
      knowledgeVersion: "v0.1",
    });

    const businessRules = fs.readFileSync(path.join(outDir, "behavior", "business-rules.md"), "utf8");
    expect(businessRules).toContain(newNode.id);
    expect(businessRules).not.toContain(oldNode.id); // the stale fact must not sit next to the corrected one

    const superseded = fs.readFileSync(path.join(outDir, "superseded.md"), "utf8");
    expect(superseded).toContain(oldNode.id);
    expect(superseded).toContain("$500");
    expect(superseded).toContain(newNode.id); // "superseded by" pointer names the replacement
  });

  it("does NOT exclude a CONFIRMED superseded target — a human has to see and resolve it, nothing hides", () => {
    const oldNode: KnowledgeNode = { ...makeRule("VIP multiplier threshold", "Threshold is $500."), status: "confirmed", confidence: null, confirmed_by: "human" };
    const newNode = { ...makeRule("VIP multiplier threshold", "Threshold is $1,000."), supersedes: oldNode.id };

    renderProjectKnowledge({
      outDir,
      projectName: "demo",
      nodes: [oldNode, newNode],
      edges: [supersedesEdge(newNode.id, oldNode.id)],
      sourceCommit: null,
      generatorVersion: "test",
      knowledgeVersion: "v0.1",
    });

    const businessRules = fs.readFileSync(path.join(outDir, "behavior", "business-rules.md"), "utf8");
    expect(businessRules).toContain(oldNode.id); // confirmed — stays visible in the normal file
    expect(businessRules).toContain(newNode.id);
    expect(fs.existsSync(path.join(outDir, "superseded.md"))).toBe(false); // nothing was actually excluded
  });

  it("writes no superseded.md at all when there's nothing superseded (no behavior change for the common case)", () => {
    const node = makeRule("Some rule", "Some content.");
    const result = renderProjectKnowledge({
      outDir,
      projectName: "demo",
      nodes: [node],
      edges: [],
      sourceCommit: null,
      generatorVersion: "test",
      knowledgeVersion: "v0.1",
    });
    expect(result.writtenFiles).not.toContain("superseded.md");
    expect(fs.existsSync(path.join(outDir, "superseded.md"))).toBe(false);
  });

  it("REGRESSION: knowledge-map.json actually contains edge data, not stripped-empty objects (found via a real pkr update --llm call)", () => {
    const oldNode = makeRule("VIP multiplier threshold", "Threshold is $500.");
    const newNode = { ...makeRule("VIP multiplier threshold", "Threshold is $1,000."), supersedes: oldNode.id };

    renderProjectKnowledge({
      outDir,
      projectName: "demo",
      nodes: [oldNode, newNode],
      edges: [supersedesEdge(newNode.id, oldNode.id)],
      sourceCommit: null,
      generatorVersion: "test",
      knowledgeVersion: "v0.1",
    });

    const knowledgeMap = JSON.parse(fs.readFileSync(path.join(outDir, "traceability", "knowledge-map.json"), "utf8"));
    expect(knowledgeMap).toEqual({
      [newNode.id]: [{ target: oldNode.id, relationship_type: "supersedes" }],
    });
  });
});

describe("renderProjectKnowledge — architecture-overview (ARCHITECTURE.md §29)", () => {
  it("renders into architecture/overview.md, the file this type existed to fill", () => {
    const allocator = IdAllocator.load(tmpDir());
    const outDir = path.join(tmpDir(), ".projectknowledge");
    const overview = makeNode(allocator, "proj", "ARCHITECTURE", {
      type: "architecture-overview",
      title: "System overview",
      content: "A narrative describing how the pieces fit together.",
      status: "inferred",
      confidence: 0.7,
      evidence: [{ path: "src/index.js" }],
    });

    renderProjectKnowledge({
      outDir,
      projectName: "demo",
      nodes: [overview],
      edges: [],
      sourceCommit: null,
      generatorVersion: "test",
      knowledgeVersion: "v0.1",
    });

    const overviewFile = fs.readFileSync(path.join(outDir, "architecture", "overview.md"), "utf8");
    expect(overviewFile).toContain("System overview");
    expect(overviewFile).toContain("A narrative describing how the pieces fit together.");
  });
});
