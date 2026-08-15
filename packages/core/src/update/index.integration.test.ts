/**
 * End-to-end regression test for the loop ARCHITECTURE.md §17 describes:
 * `pkr export` -> repo changes -> `pkr update` shows a semantic diff and
 * preserves confirmed knowledge. No LLM involved (deterministic layer only,
 * options.llm omitted throughout) — this is exactly what ships without an
 * ANTHROPIC_API_KEY.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runExport } from "../pipeline.js";
import { runUpdate } from "./index.js";
import { FileNodeStore } from "../store/fileNodeStore.js";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klerk-repo-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export function main() {}\n");
  writePackageJson(dir, { zod: "^3.23.8" });
  return dir;
}

function writePackageJson(dir: string, deps: Record<string, string>): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      { name: "fixture-app", version: "0.0.1", dependencies: deps, scripts: { build: "tsc", test: "vitest" } },
      null,
      2,
    ),
  );
}

function knowledgeDirOf(repo: string): string {
  return path.join(repo, ".projectknowledge", ".knowledge");
}

describe("export -> update integration", () => {
  let repo: string;

  beforeEach(async () => {
    repo = tmpRepo();
    await runExport({ repoRoot: repo, llm: null });
  });

  it("pkr export produced a zod dependency node", () => {
    const store = FileNodeStore.load(knowledgeDirOf(repo));
    const zod = store.listNodes({ type: "dependency" }).find((n) => n.title.startsWith("zod"));
    expect(zod?.title).toBe("zod (^3.23.8)");
  });

  it("is up to date (no-op) when nothing changed", async () => {
    const result = await runUpdate({ repoRoot: repo, llm: null });
    expect(result.upToDate).toBe(true);
    expect(result.writtenFiles).toHaveLength(0);
  });

  it("reports a semantic diff (+/~) when package.json changes, and preserves the node ID across the version bump", async () => {
    const storeBefore = FileNodeStore.load(knowledgeDirOf(repo));
    const zodBefore = storeBefore.listNodes({ type: "dependency" }).find((n) => n.title.startsWith("zod"))!;

    writePackageJson(repo, { zod: "^3.24.0", "left-pad": "^1.0.0" }); // bump + add
    const result = await runUpdate({ repoRoot: repo, llm: null });

    expect(result.upToDate).toBe(false);
    expect(result.fileDiff.modified).toContain("package.json");

    const merge = result.nodeMerge!;
    expect(merge.added.some((n) => n.title === "left-pad (^1.0.0)")).toBe(true);
    const zodModified = merge.modified.find((m) => m.before.id === zodBefore.id);
    expect(zodModified?.after.id).toBe(zodBefore.id); // same natural key -> same stable ID
    expect(zodModified?.after.title).toBe("zod (^3.24.0)");
  });

  it("REGRESSION: routes a confirmed node to a conflict on update instead of silently rewriting it", async () => {
    // A human confirms the zod dependency node.
    const knowledgeDir = knowledgeDirOf(repo);
    const store = FileNodeStore.load(knowledgeDir);
    const zod = store.listNodes({ type: "dependency" }).find((n) => n.title.startsWith("zod"))!;
    store.upsertNode({ ...zod, status: "confirmed", confidence: null, confirmed_by: "human" });
    store.save();

    // Extraction now disagrees (version bumped).
    writePackageJson(repo, { zod: "^3.24.0" });
    const result = await runUpdate({ repoRoot: repo, llm: null });

    const merge = result.nodeMerge!;
    expect(merge.modified.some((m) => m.before.id === zod.id)).toBe(false); // never silently modified
    expect(merge.conflicts.some((c) => c.existing.id === zod.id)).toBe(true);

    const storeAfter = FileNodeStore.load(knowledgeDir);
    const confirmedAfter = storeAfter.getNode(zod.id)!;
    expect(confirmedAfter.status).toBe("confirmed");
    expect(confirmedAfter.title).toBe("zod (^3.23.8)"); // original value survives, untouched
  });
});
