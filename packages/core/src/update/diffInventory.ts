/**
 * File-level diff between two inventories — ARCHITECTURE.md §2 "the hash set
 * is what `pkr update` diffs against." This is the trigger signal: which
 * files changed since the last export/update, by content hash, not mtime.
 */

import type { InventoryFile } from "../extract/inventory.js";

export interface InventoryDiff {
  added: string[];
  modified: string[];
  removed: string[];
  unchanged: number;
}

export function diffInventory(previous: InventoryFile[], current: InventoryFile[]): InventoryDiff {
  const prevByPath = new Map(previous.map((f) => [f.path, f]));
  const currByPath = new Map(current.map((f) => [f.path, f]));

  const added: string[] = [];
  const modified: string[] = [];
  let unchanged = 0;

  for (const [p, curr] of currByPath) {
    const prev = prevByPath.get(p);
    if (!prev) {
      added.push(p);
    } else if (prev.sha256 !== curr.sha256) {
      modified.push(p);
    } else {
      unchanged++;
    }
  }

  const removed = [...prevByPath.keys()].filter((p) => !currByPath.has(p));

  return {
    added: added.sort(),
    modified: modified.sort(),
    removed: removed.sort(),
    unchanged,
  };
}

export function hasChanges(diff: InventoryDiff): boolean {
  return diff.added.length > 0 || diff.modified.length > 0 || diff.removed.length > 0;
}
