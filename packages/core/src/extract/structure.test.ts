/**
 * Stage 4 (ARCHITECTURE.md §2) had zero direct test coverage — a known,
 * tracked gap (§0's "Automated test suite" row) even though it's exercised
 * indirectly through every `pkr export`/`pkr update` integration test.
 * `analyzeStructure` is pure metadata analysis over an already-built
 * `Inventory` (no file content read, no disk I/O of its own), so these
 * construct `Inventory` objects directly rather than writing real files —
 * there's nothing content-based here to make writing real files worthwhile.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IdAllocator } from "../ids.js";
import { analyzeStructure } from "./structure.js";
import type { Inventory, FileKind } from "./inventory.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-structure-"));
}

function file(p: string, kind: FileKind = "source") {
  return { path: p, kind, sizeBytes: 1, sha256: "irrelevant" };
}

function inventoryOf(files: ReturnType<typeof file>[]): Inventory {
  return { root: "/irrelevant", files };
}

describe("analyzeStructure", () => {
  let allocator: IdAllocator;

  beforeEach(() => {
    allocator = IdAllocator.load(tmpDir());
  });

  it("makes a component node per top-level directory that contains source files", () => {
    const inventory = inventoryOf([file("src/index.ts"), file("src/util.ts"), file("docs/README.md", "docs")]);
    const nodes = analyzeStructure(inventory, allocator, "proj");
    const components = nodes.filter((n) => n.type === "component");
    expect(components).toHaveLength(1);
    expect(components[0].title).toBe("src/");
    expect(components[0].content).toContain("2 source file(s)");
  });

  it("skips top-level directories with no source files (docs-only, config-only)", () => {
    const inventory = inventoryOf([file("docs/README.md", "docs"), file("README.md")]); // root-level file has no top dir at all
    const nodes = analyzeStructure(inventory, allocator, "proj");
    expect(nodes.filter((n) => n.type === "component")).toHaveLength(0);
  });

  it("ignores files at the repo root (no top-level directory) entirely", () => {
    const inventory = inventoryOf([file("package.json"), file("README.md")]);
    const nodes = analyzeStructure(inventory, allocator, "proj");
    expect(nodes.filter((n) => n.type === "component")).toHaveLength(0);
  });

  it("mentions co-located test files in a component's content when present", () => {
    const inventory = inventoryOf([file("src/index.ts"), file("src/index.test.ts", "test")]);
    const nodes = analyzeStructure(inventory, allocator, "proj");
    const component = nodes.find((n) => n.type === "component")!;
    expect(component.content).toContain("1 test file(s)");
  });

  it("sorts component nodes alphabetically by directory name", () => {
    const inventory = inventoryOf([file("zeta/a.ts"), file("alpha/b.ts")]);
    const nodes = analyzeStructure(inventory, allocator, "proj");
    const titles = nodes.filter((n) => n.type === "component").map((n) => n.title);
    expect(titles).toEqual(["alpha/", "zeta/"]);
  });

  it("detects a monorepo/workspace convention when packages/apps/services exist", () => {
    const inventory = inventoryOf([file("packages/core/index.ts"), file("apps/web/index.ts")]);
    const nodes = analyzeStructure(inventory, allocator, "proj");
    const convention = nodes.find((n) => n.type === "convention" && n.title === "Monorepo / workspace layout");
    expect(convention).toBeDefined();
    expect(convention!.content).toContain("`packages/`");
    expect(convention!.content).toContain("`apps/`");
    expect(convention!.evidence).toEqual([{ path: "packages/" }, { path: "apps/" }]);
  });

  it("does not claim a monorepo convention for an unrelated top-level directory", () => {
    const inventory = inventoryOf([file("src/index.ts")]);
    const nodes = analyzeStructure(inventory, allocator, "proj");
    expect(nodes.find((n) => n.title === "Monorepo / workspace layout")).toBeUndefined();
  });

  it("reports colocated tests when most test files sit beside their source", () => {
    const inventory = inventoryOf([
      file("src/index.ts"),
      file("src/index.test.ts", "test"),
      file("src/util.ts"),
      file("src/util.test.ts", "test"),
    ]);
    const nodes = analyzeStructure(inventory, allocator, "proj");
    const convention = nodes.find((n) => n.type === "convention" && n.title.includes("colocated"));
    expect(convention).toBeDefined();
    expect(convention!.content).toContain("2 of 2 test files");
  });

  it("reports a dedicated test directory when most tests live under one", () => {
    const inventory = inventoryOf([
      file("src/index.ts"),
      file("__tests__/index.test.ts", "test"),
      file("__tests__/util.test.ts", "test"),
    ]);
    const nodes = analyzeStructure(inventory, allocator, "proj");
    const convention = nodes.find((n) => n.type === "convention" && n.title.includes("dedicated directory"));
    expect(convention).toBeDefined();
    expect(convention!.content).toContain("2 of 2 test files");
  });

  it("emits no test-location convention node when there are no test files at all", () => {
    const inventory = inventoryOf([file("src/index.ts")]);
    const nodes = analyzeStructure(inventory, allocator, "proj");
    expect(nodes.some((n) => n.title.toLowerCase().includes("test"))).toBe(false);
  });

  it("every emitted node is status: observed with null confidence (stage 4 makes no judgment calls)", () => {
    const inventory = inventoryOf([file("packages/core/index.ts"), file("packages/core/index.test.ts", "test")]);
    const nodes = analyzeStructure(inventory, allocator, "proj");
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(n.status).toBe("observed");
      expect(n.confidence).toBeNull();
    }
  });

  it("returns nothing for an empty inventory", () => {
    expect(analyzeStructure(inventoryOf([]), allocator, "proj")).toEqual([]);
  });
});
