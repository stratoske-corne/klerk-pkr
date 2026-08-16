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
import { IdAllocator } from "../ids.js";
import { makeInferredNode } from "../node-factory.js";
import { listVersions } from "../versions.js";
import type { LlmClient } from "../llm/client.js";

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

describe("Knowledge Versioning end-to-end (ARCHITECTURE.md §24)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = tmpRepo();
    await runExport({ repoRoot: repo, llm: null });
  });

  it("pkr export commits v0.1 with every node listed as added", () => {
    const versions = listVersions(knowledgeDirOf(repo));
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe("v0.1");
    expect(versions[0].parent_version).toBeNull();
    expect(versions[0].changed_nodes.every((c) => c.change === "added")).toBe(true);
  });

  it("a no-op pkr update commits no new version", async () => {
    const result = await runUpdate({ repoRoot: repo, llm: null });
    expect(result.upToDate).toBe(true);
    expect(result.knowledgeVersion).toBeNull();
    expect(listVersions(knowledgeDirOf(repo))).toHaveLength(1); // still just v0.1
  });

  it("a real change commits v0.2, chained to v0.1, and the manifest reflects it", async () => {
    writePackageJson(repo, { zod: "^3.24.0", "left-pad": "^1.0.0" });
    const result = await runUpdate({ repoRoot: repo, llm: null });

    expect(result.knowledgeVersion).toBe("v0.2");
    const versions = listVersions(knowledgeDirOf(repo));
    expect(versions.map((v) => v.version)).toEqual(["v0.1", "v0.2"]);
    expect(versions[1].parent_version).toBe("v0.1");
    expect(versions[1].changed_nodes.some((c) => c.change === "added")).toBe(true);
    expect(versions[1].changed_nodes.some((c) => c.change === "modified")).toBe(true);

    const manifest = fs.readFileSync(path.join(repo, ".projectknowledge", "manifest.yaml"), "utf8");
    expect(manifest).toContain("knowledge_version: v0.2");
  });
});

describe("export -> update integration with LLM reconciliation (ARCHITECTURE.md §19)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = tmpRepo();
    await runExport({ repoRoot: repo, llm: null });
  });

  it("REGRESSION: pkr update --llm supersedes a stale inferred node instead of leaving a contradiction (§16 Run 4 scenario, reproduced end-to-end)", async () => {
    const knowledgeDir = knowledgeDirOf(repo);
    const allocator = IdAllocator.load(knowledgeDir);
    const store = FileNodeStore.load(knowledgeDir);
    const oldNode = makeInferredNode(allocator, "fixture-app", "POINTS", {
      type: "business-rule",
      title: "VIP 2x multiplier applies only to purchase-earned points",
      content: "Accounts with lifetimeSpendCents >= $500 get a 2x multiplier.",
      confidence: 0.9,
      evidence: [{ path: "package.json" }],
    });
    store.upsertNode(oldNode);
    allocator.save();
    store.save();

    // Something changes so `pkr update` doesn't short-circuit as "up to date".
    writePackageJson(repo, { zod: "^3.24.0" });

    const fakeLlm: LlmClient = {
      async complete() {
        return JSON.stringify({
          nodes: [
            {
              type: "business-rule",
              title: "VIP 2x multiplier applies only to purchase-earned points",
              content: "Accounts with lifetime spend >= $1,000 get a 2x multiplier.",
              confidence: 0.85,
              domain: "POINTS",
              evidence: [{ path: "package.json" }],
              supersedes: [oldNode.id],
            },
          ],
        });
      },
    };

    const result = await runUpdate({ repoRoot: repo, llm: fakeLlm });

    expect(result.llm?.ranSuccessfully).toBe(true);
    expect(result.llm?.superseded).toHaveLength(1);
    expect(result.llm?.superseded[0].target.id).toBe(oldNode.id);
    expect(result.llm?.conflicts).toHaveLength(0);

    // The exact §16 Run 4 symptom must no longer reproduce: the stale fact
    // shouldn't sit next to the corrected one in the rendered output.
    const rendered = fs.readFileSync(path.join(repo, ".projectknowledge", "behavior", "business-rules.md"), "utf8");
    expect(rendered).not.toContain(oldNode.id);
    expect(rendered).toContain(result.llm!.added[0].id);

    const supersededFile = fs.readFileSync(path.join(repo, ".projectknowledge", "superseded.md"), "utf8");
    expect(supersededFile).toContain(oldNode.id);
    expect(supersededFile).toContain("$500");
    expect(supersededFile).toContain(result.llm!.added[0].id);

    // And the underlying store still has the old node — nothing was deleted, only hidden from the main render.
    const storeAfter = FileNodeStore.load(knowledgeDir);
    expect(storeAfter.getNode(oldNode.id)).toBeDefined();
  });
});

describe("pkr update --llm failure does not silently forfeit a retry (ARCHITECTURE.md §16 Run 4 process finding)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = tmpRepo();
    await runExport({ repoRoot: repo, llm: null });
  });

  const failingLlm: LlmClient = {
    async complete() {
      throw new Error("simulated transient failure (rate limit / network / overload)");
    },
  };

  it("REGRESSION: a failed stage-6 call does not advance the inventory baseline, so the same changes are still there to retry", async () => {
    writePackageJson(repo, { zod: "^3.24.0" }); // real change, so this doesn't short-circuit as "up to date"

    const first = await runUpdate({ repoRoot: repo, llm: failingLlm });
    expect(first.upToDate).toBe(false);
    expect(first.llm?.ranSuccessfully).toBe(false);

    // With the old code, this second call would see the inventory baseline
    // already advanced by the first (failed) call and report "up to date"
    // without ever re-attempting stage 6.
    const second = await runUpdate({ repoRoot: repo, llm: failingLlm });
    expect(second.upToDate).toBe(false);
    expect(second.llm?.ranSuccessfully).toBe(false); // it was actually retried, not skipped
  });

  it("still saves deterministic merge results even when stage 6 fails in the same run", async () => {
    writePackageJson(repo, { zod: "^3.24.0", "left-pad": "^1.0.0" });

    const result = await runUpdate({ repoRoot: repo, llm: failingLlm });
    expect(result.llm?.ranSuccessfully).toBe(false);
    expect(result.nodeMerge?.added.some((n) => n.title === "left-pad (^1.0.0)")).toBe(true);

    const store = FileNodeStore.load(knowledgeDirOf(repo));
    expect(store.listNodes({ type: "dependency" }).some((n) => n.title === "left-pad (^1.0.0)")).toBe(true);
  });

  it("succeeds normally on retry once the LLM call starts working, picking up the same underlying changes", async () => {
    writePackageJson(repo, { zod: "^3.24.0" });
    await runUpdate({ repoRoot: repo, llm: failingLlm }); // fails, baseline not advanced

    const workingLlm: LlmClient = {
      async complete() {
        return JSON.stringify({ nodes: [] });
      },
    };
    const retry = await runUpdate({ repoRoot: repo, llm: workingLlm });
    expect(retry.upToDate).toBe(false); // the change from before is still pending
    expect(retry.llm?.ranSuccessfully).toBe(true);

    // And now the baseline IS advanced — a further call with no new changes is genuinely up to date.
    const third = await runUpdate({ repoRoot: repo, llm: workingLlm });
    expect(third.upToDate).toBe(true);
  });
});
