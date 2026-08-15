import { describe, it, expect } from "vitest";
import { diffInventory, hasChanges } from "./diffInventory.js";
import type { InventoryFile } from "../extract/inventory.js";

function file(p: string, sha256: string): InventoryFile {
  return { path: p, kind: "source", sizeBytes: 1, sha256 };
}

describe("diffInventory", () => {
  it("classifies added, modified, removed, and unchanged files by content hash, not path presence alone", () => {
    const previous = [file("a.ts", "hash-a"), file("b.ts", "hash-b"), file("c.ts", "hash-c")];
    const current = [file("a.ts", "hash-a"), file("b.ts", "hash-b-CHANGED"), file("d.ts", "hash-d")];

    const diff = diffInventory(previous, current);
    expect(diff.added).toEqual(["d.ts"]);
    expect(diff.modified).toEqual(["b.ts"]);
    expect(diff.removed).toEqual(["c.ts"]);
    expect(diff.unchanged).toBe(1);
  });

  it("is a full no-op diff when nothing changed", () => {
    const files = [file("a.ts", "hash-a"), file("b.ts", "hash-b")];
    const diff = diffInventory(files, files);
    expect(diff).toEqual({ added: [], modified: [], removed: [], unchanged: 2 });
    expect(hasChanges(diff)).toBe(false);
  });

  it("hasChanges is true if any of added/modified/removed is non-empty", () => {
    expect(hasChanges({ added: ["x"], modified: [], removed: [], unchanged: 0 })).toBe(true);
    expect(hasChanges({ added: [], modified: [], removed: ["x"], unchanged: 0 })).toBe(true);
  });
});
