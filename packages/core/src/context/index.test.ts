/**
 * `pkr context`'s staleness check (ARCHITECTURE.md — agent-instruction
 * automation): drives `runExport` -> `runContext` against a real tmp repo,
 * so this exercises the actual `diffInventory` wiring, not a mock.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runExport } from "../pipeline.js";
import { runContext } from "./index.js";
import { IdAllocator } from "../ids.js";
import { makeInferredNode } from "../node-factory.js";
import { FileNodeStore } from "../store/fileNodeStore.js";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klerk-ctx-repo-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export function main() {}\n");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "0.0.1", dependencies: { zod: "^3.23.8" } }, null, 2),
  );
  return dir;
}

describe("runContext staleness check", () => {
  let repo: string;
  let pkrDir: string;

  beforeEach(async () => {
    repo = tmpRepo();
    const exportResult = await runExport({ repoRoot: repo, llm: null });
    pkrDir = exportResult.outDir;
  });

  it("reports zero changed files right after export", () => {
    const result = runContext({ pkrDir, repoRoot: repo });
    expect(result.staleness).toEqual({ changedFileCount: 0 });
  });

  it("detects drift once a file changes", () => {
    fs.writeFileSync(path.join(repo, "src", "index.ts"), "export function main() { return 1; }\n");
    const result = runContext({ pkrDir, repoRoot: repo });
    expect(result.staleness).toEqual({ changedFileCount: 1 });
  });

  it("detects an added file", () => {
    fs.writeFileSync(path.join(repo, "src", "extra.ts"), "export const x = 1;\n");
    const result = runContext({ pkrDir, repoRoot: repo });
    expect(result.staleness).toEqual({ changedFileCount: 1 });
  });

  it("defaults repoRoot to the PKR directory's parent when not given", () => {
    // pkrDir is `${repo}/.projectknowledge` here, so the default should resolve back to `repo`.
    const result = runContext({ pkrDir });
    expect(result.staleness).toEqual({ changedFileCount: 0 });
  });

  it("reports null (unknown) rather than throwing when the repo root doesn't exist", () => {
    const result = runContext({ pkrDir, repoRoot: path.join(repo, "does-not-exist") });
    expect(result.staleness).toBeNull();
  });

  it("REGRESSION: pkr context's own output directory doesn't count as drift on the next run", () => {
    const first = runContext({ pkrDir, repoRoot: repo }); // writes .context/PROJECT_CONTEXT.md into the repo
    expect(first.staleness).toEqual({ changedFileCount: 0 });

    const second = runContext({ pkrDir, repoRoot: repo }); // must not see its own prior output as an added file
    expect(second.staleness).toEqual({ changedFileCount: 0 });
  });

  it("the rendered context file surfaces the staleness result in its text", () => {
    fs.writeFileSync(path.join(repo, "src", "index.ts"), "export function main() { return 2; }\n");
    const result = runContext({ pkrDir, repoRoot: repo });
    const content = fs.readFileSync(result.filePath, "utf8");
    expect(content).toContain("Stale:");
    expect(content).toContain("1 file(s)");
    expect(content).toContain("pkr update <repo>"); // the end-of-session instruction
  });

  it("REGRESSION: excludes a superseded (non-confirmed) node from the context file — this render path never received edges at all until found missing", () => {
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

    const result = runContext({ pkrDir, repoRoot: repo });
    const content = fs.readFileSync(result.filePath, "utf8");
    expect(content).toContain(newNode.id);
    expect(content).toContain("$1,000");
    expect(content).not.toContain(oldNode.id); // the stale fact must never reach an agent through this file
    expect(content).not.toContain("$500");
  });
});
