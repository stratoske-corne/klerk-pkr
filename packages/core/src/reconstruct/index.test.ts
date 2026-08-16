/**
 * ARCHITECTURE.md §19 — same superseded-node exclusion as render.ts and
 * context/render.ts, found missing here too while auditing all three render
 * paths for the same gap (each reads the node/edge graph independently, so
 * fixing one doesn't fix the others — see supersede.ts's module doc).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runExport } from "../pipeline.js";
import { runReconstruct } from "./index.js";
import { IdAllocator } from "../ids.js";
import { makeInferredNode } from "../node-factory.js";
import { FileNodeStore } from "../store/fileNodeStore.js";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klerk-reconstruct-repo-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export function main() {}\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture-app", version: "0.0.1" }, null, 2));
  return dir;
}

describe("runReconstruct — superseded nodes", () => {
  it("REGRESSION: excludes a superseded (non-confirmed) node from the reconstruction package", async () => {
    const repo = tmpRepo();
    const exportResult = await runExport({ repoRoot: repo, llm: null });
    const pkrDir = exportResult.outDir;
    const knowledgeDir = path.join(pkrDir, ".knowledge");

    const allocator = IdAllocator.load(knowledgeDir);
    const store = FileNodeStore.load(knowledgeDir);
    const oldNode = makeInferredNode(allocator, "fixture-app", "POINTS", {
      type: "business-rule",
      title: "VIP threshold",
      content: "Threshold is $500.",
      confidence: 0.9,
      evidence: [{ path: "package.json" }],
    });
    const newNode = makeInferredNode(allocator, "fixture-app", "POINTS", {
      type: "business-rule",
      title: "VIP threshold",
      content: "Threshold is $1,000.",
      confidence: 0.85,
      evidence: [{ path: "package.json" }],
      supersedes: oldNode.id,
    });
    store.upsertNode(oldNode);
    store.upsertNode(newNode);
    store.upsertEdge({
      id: `${newNode.id}--supersedes--${oldNode.id}`,
      project_id: "fixture-app",
      source_node: newNode.id,
      target_node: oldNode.id,
      relationship_type: "supersedes",
      created_at: new Date().toISOString(),
    });
    allocator.save();
    store.save();

    const result = runReconstruct({ pkrDir });
    const contextMd = fs.readFileSync(path.join(result.outDir, "CONTEXT.md"), "utf8");

    expect(contextMd).toContain(newNode.id);
    expect(contextMd).toContain("$1,000");
    expect(contextMd).not.toContain(oldNode.id);
    expect(contextMd).not.toContain("$500");
  });
});
