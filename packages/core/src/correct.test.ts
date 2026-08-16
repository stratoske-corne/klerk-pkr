import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runExport } from "./pipeline.js";
import { confirmOrEditNode } from "./correct.js";
import { FileNodeStore } from "./store/fileNodeStore.js";
import { listVersions } from "./versions.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-correct-"));
}

async function exportedPkr(): Promise<{ repo: string; outDir: string; nodeId: string }> {
  const repo = tmpDir();
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "const app = require('express')();\napp.get('/status', (req, res) => res.send('ok'));\n");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2));
  await runExport({ repoRoot: repo, llm: null });
  const outDir = path.join(repo, ".projectknowledge");
  const store = FileNodeStore.load(path.join(outDir, ".knowledge"));
  const node = store.listNodes({ type: "api-endpoint" })[0];
  return { repo, outDir, nodeId: node.id };
}

describe("confirmOrEditNode", () => {
  it("pkr confirm marks a node confirmed without touching title/content", async () => {
    const { outDir, nodeId } = await exportedPkr();
    const before = FileNodeStore.load(path.join(outDir, ".knowledge")).getNode(nodeId)!;

    const result = confirmOrEditNode({ outDir, nodeId });

    expect(result.node.status).toBe("confirmed");
    expect(result.node.confidence).toBeNull();
    expect(result.node.confirmed_by).toBe("human");
    expect(result.node.title).toBe(before.title);
    expect(result.node.content).toBe(before.content);
    expect(result.wasAlreadyConfirmed).toBe(false);
  });

  it("pkr edit overwrites title/content and also confirms", async () => {
    const { outDir, nodeId } = await exportedPkr();

    const result = confirmOrEditNode({ outDir, nodeId, title: "Corrected title", content: "Corrected content." });

    expect(result.node.status).toBe("confirmed");
    expect(result.node.title).toBe("Corrected title");
    expect(result.node.content).toBe("Corrected content.");
  });

  it("persists the correction — a fresh store load sees it", async () => {
    const { outDir, nodeId } = await exportedPkr();
    confirmOrEditNode({ outDir, nodeId, title: "Persisted title" });

    const reloaded = FileNodeStore.load(path.join(outDir, ".knowledge")).getNode(nodeId)!;
    expect(reloaded.status).toBe("confirmed");
    expect(reloaded.title).toBe("Persisted title");
  });

  it("re-confirming an already-confirmed node succeeds and reports wasAlreadyConfirmed", async () => {
    const { outDir, nodeId } = await exportedPkr();
    confirmOrEditNode({ outDir, nodeId });
    const second = confirmOrEditNode({ outDir, nodeId, content: "Refined content." });

    expect(second.wasAlreadyConfirmed).toBe(true);
    expect(second.node.content).toBe("Refined content.");
  });

  it("commits a Knowledge Version authored by a human, distinct from automated commits", async () => {
    const { outDir, nodeId } = await exportedPkr();
    const result = confirmOrEditNode({ outDir, nodeId });

    const versions = listVersions(path.join(outDir, ".knowledge"));
    const committed = versions.find((v) => v.version === result.knowledgeVersion)!;
    expect(committed.author).toBe("human");
    expect(committed.changed_nodes).toEqual([{ id: nodeId, change: "confirmed" }]);
  });

  it("throws a clear error for an unknown node ID", async () => {
    const { outDir } = await exportedPkr();
    expect(() => confirmOrEditNode({ outDir, nodeId: "NOPE-DOES-NOT-EXIST" })).toThrow(/No node "NOPE-DOES-NOT-EXIST"/);
  });

  it("throws a clear error when the PKR directory doesn't exist", () => {
    expect(() => confirmOrEditNode({ outDir: "/this/path/does/not/exist", nodeId: "X" })).toThrow(/Not a Project Knowledge Repository/);
  });
});
