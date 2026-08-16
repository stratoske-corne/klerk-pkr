import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IdAllocator } from "../ids.js";
import { makeNode } from "../node-factory.js";
import { FileNodeStore, ConfirmedNodeOverwriteError } from "./fileNodeStore.js";
import type { KnowledgeNode } from "../types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-store-"));
}

function makeConfirmed(node: KnowledgeNode): KnowledgeNode {
  return { ...node, status: "confirmed", confidence: null, confirmed_by: "human" };
}

describe("FileNodeStore", () => {
  let dir: string;
  let allocator: IdAllocator;

  beforeEach(() => {
    dir = tmpDir();
    allocator = IdAllocator.load(dir);
  });

  it("round-trips nodes and edges through save/load, sorted by ID", () => {
    const store = FileNodeStore.load(dir);
    const a = makeNode(allocator, "proj", "AUTH", {
      type: "component",
      title: "Auth",
      content: "c",
      status: "observed",
      confidence: null,
      evidence: [{ path: "a.ts" }],
    });
    const b = makeNode(allocator, "proj", "AUTH", {
      type: "component",
      title: "Auth2",
      content: "c",
      status: "observed",
      confidence: null,
      evidence: [{ path: "b.ts" }],
    });
    store.upsertNode(b);
    store.upsertNode(a);
    store.upsertEdge({
      id: "e1",
      project_id: "proj",
      source_node: a.id,
      target_node: b.id,
      relationship_type: "depends_on",
      created_at: new Date().toISOString(),
    });
    store.save();

    const reloaded = FileNodeStore.load(dir);
    expect(reloaded.listNodes().map((n) => n.id)).toEqual([a.id, b.id]); // sorted
    expect(reloaded.listEdges()).toHaveLength(1);
    expect(reloaded.getNode(a.id)?.title).toBe("Auth");
  });

  it("filters listNodes by type", () => {
    const store = FileNodeStore.load(dir);
    const comp = makeNode(allocator, "proj", "AUTH", {
      type: "component",
      title: "Auth",
      content: "c",
      status: "observed",
      confidence: null,
      evidence: [{ path: "a.ts" }],
    });
    const dep = makeNode(allocator, "proj", "DEPS", {
      type: "dependency",
      title: "zod (^3)",
      content: "c",
      status: "observed",
      confidence: null,
      evidence: [{ path: "package.json" }],
    });
    store.upsertNode(comp);
    store.upsertNode(dep);
    expect(store.listNodes({ type: "component" })).toEqual([comp]);
  });

  it("refuses to silently overwrite a confirmed node", () => {
    const store = FileNodeStore.load(dir);
    const original = makeNode(allocator, "proj", "AUTH", {
      type: "component",
      title: "Auth",
      content: "original",
      status: "observed",
      confidence: null,
      evidence: [{ path: "a.ts" }],
    });
    store.upsertNode(makeConfirmed(original));

    const rewrite = { ...original, content: "silently changed", confirmed_by: null };
    expect(() => store.upsertNode(rewrite)).toThrow(ConfirmedNodeOverwriteError);
    expect(store.getNode(original.id)?.content).toBe("original"); // untouched
  });

  it("allows overwriting a confirmed node only when the incoming node is itself human-confirmed", () => {
    const store = FileNodeStore.load(dir);
    const original = makeNode(allocator, "proj", "AUTH", {
      type: "component",
      title: "Auth",
      content: "original",
      status: "observed",
      confidence: null,
      evidence: [{ path: "a.ts" }],
    });
    store.upsertNode(makeConfirmed(original));

    const humanEdit = { ...makeConfirmed(original), content: "edited by a human, on purpose" };
    expect(() => store.upsertNode(humanEdit)).not.toThrow();
    expect(store.getNode(original.id)?.content).toBe("edited by a human, on purpose");
  });

  it("refuses to delete a confirmed node", () => {
    const store = FileNodeStore.load(dir);
    const original = makeNode(allocator, "proj", "AUTH", {
      type: "component",
      title: "Auth",
      content: "c",
      status: "observed",
      confidence: null,
      evidence: [{ path: "a.ts" }],
    });
    store.upsertNode(makeConfirmed(original));
    expect(() => store.deleteNode(original.id)).toThrow(ConfirmedNodeOverwriteError);
  });

  it("deletes a non-confirmed node without complaint", () => {
    const store = FileNodeStore.load(dir);
    const node = makeNode(allocator, "proj", "AUTH", {
      type: "component",
      title: "Auth",
      content: "c",
      status: "observed",
      confidence: null,
      evidence: [{ path: "a.ts" }],
    });
    store.upsertNode(node);
    store.deleteNode(node.id);
    expect(store.getNode(node.id)).toBeUndefined();
  });

  // SECURITY REGRESSION (ARCHITECTURE.md §31): PKR_SPEC.md §10 says a
  // secret must never be written into "any generated file" — the internal
  // .knowledge/nodes.jsonl is one, but the write-gate had only ever been
  // wired into render.ts's Markdown output. Confirmed with a real
  // AWS-shaped key before this fix: `pkr edit`'s human-typed content
  // reached disk in this file completely unredacted.
  it("SECURITY: redacts a secret-shaped value from node content before it reaches nodes.jsonl on disk", () => {
    const store = FileNodeStore.load(dir);
    const node = makeNode(allocator, "proj", "AUTH", {
      type: "component",
      title: "Auth",
      content: "See AKIAIOSFODNN7EXAMPLE for the AWS key we use.",
      status: "observed",
      confidence: null,
      evidence: [{ path: "a.ts" }],
    });
    store.upsertNode(node);
    store.save();

    const onDisk = fs.readFileSync(path.join(dir, "nodes.jsonl"), "utf8");
    expect(onDisk).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(onDisk).toContain("[REDACTED:AWS access key]");
  });
});
