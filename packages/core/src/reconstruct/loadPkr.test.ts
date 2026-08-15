/**
 * Portability regression test — PKR_SPEC.md §0/§8: "the format must survive
 * losing the internal store." Renders a small graph, loads it back via the
 * fast jsonl path, then deletes `.knowledge/` and loads it back again via the
 * markdown-fallback parser, asserting the two loads agree on everything the
 * fallback parser is actually scoped to recover (see reconstruct/loadPkr.ts
 * module doc — it does not recover project_id, timestamps, supersedes, or
 * per-symbol evidence, since no render/extraction path round-trips those
 * either).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IdAllocator } from "../ids.js";
import { makeNode, makeInferredNode } from "../node-factory.js";
import { FileNodeStore } from "../store/fileNodeStore.js";
import { renderProjectKnowledge } from "../render/render.js";
import { loadPkr } from "./loadPkr.js";
import type { KnowledgeNode } from "../types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-loadpkr-"));
}

/** Fields the markdown-fallback parser is not scoped to recover (documented gap). */
function normalize(node: KnowledgeNode) {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    content: node.content,
    status: node.status,
    confidence: node.confidence,
    confirmed_by: node.confirmed_by,
    evidence: node.evidence,
  };
}

describe("loadPkr: jsonl vs markdown-fallback parity", () => {
  let outDir: string;
  let nodes: KnowledgeNode[];

  beforeEach(() => {
    const dir = tmpDir();
    outDir = path.join(dir, ".projectknowledge");
    const knowledgeDir = path.join(outDir, ".knowledge");
    const allocator = IdAllocator.load(knowledgeDir);
    const store = FileNodeStore.load(knowledgeDir);

    const dep = makeNode(allocator, "proj", "DEPS", {
      type: "dependency",
      title: "zod (^3.23.8)",
      content: "zod is a runtime dependency, declared in package.json.",
      status: "observed",
      confidence: null,
      evidence: [{ path: "package.json" }],
    });
    const req = makeInferredNode(allocator, "proj", "PROD", {
      type: "requirement",
      title: "Users can reset their password",
      content: "Inferred from a /forgot-password route and a nearby mailer call.",
      confidence: 0.75,
      evidence: [{ path: "src/routes/auth.ts", lines: [10, 25] }],
    });
    const confirmed = makeNode(allocator, "proj", "AUTH", {
      type: "component",
      title: "Auth service",
      content: "Handles login and session issuance.",
      status: "observed",
      confidence: null,
      evidence: [{ path: "src/auth/index.ts" }],
    });
    const confirmedNode: KnowledgeNode = { ...confirmed, status: "confirmed", confidence: null, confirmed_by: "human" };
    const decision = makeNode(allocator, "proj", undefined, {
      type: "decision",
      title: "Use Redis for session storage",
      content: "Chosen over in-memory sessions for horizontal scalability.",
      status: "observed",
      confidence: null,
      evidence: [{ path: "docs/adr/0001-sessions.md" }],
    });

    nodes = [dep, req, confirmedNode, decision];
    for (const n of nodes) store.upsertNode(n);
    allocator.save();
    store.save(); // writes .knowledge/nodes.jsonl + edges.jsonl

    renderProjectKnowledge({
      outDir,
      projectName: "fixture-app",
      nodes: store.listNodes(),
      edges: store.listEdges(),
      sourceCommit: null,
      generatorVersion: "pkr-cli@0.1.0",
      knowledgeVersion: "v0.1",
    });
  });

  it("loads from .knowledge/*.jsonl when present", () => {
    const loaded = loadPkr(outDir);
    expect(loaded.source).toBe("jsonl");
    expect(loaded.nodes.map(normalize).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      nodes.map(normalize).sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("falls back to parsing the rendered Markdown when .knowledge/ is gone, and recovers the same facts", () => {
    fs.rmSync(path.join(outDir, ".knowledge"), { recursive: true, force: true });

    const loaded = loadPkr(outDir);
    expect(loaded.source).toBe("markdown-fallback");
    expect(loaded.nodes.map(normalize).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      nodes.map(normalize).sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("throws a clear error when there is no manifest.yaml at all", () => {
    const emptyDir = tmpDir();
    expect(() => loadPkr(emptyDir)).toThrow(/no manifest\.yaml/);
  });
});
