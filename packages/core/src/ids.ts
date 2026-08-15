/**
 * Stable ID allocation — PKR_SPEC.md §5.
 *
 * Format: <PREFIX>-<DOMAIN>-<NNN>, except decisions which are sequential and
 * domain-less: DEC-NNNN. IDs are never reused, even if the node is later
 * deleted, so a counter is persisted per (prefix, domain) key rather than
 * derived by counting current nodes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ID_PREFIX_BY_NODE_TYPE, type NodeType } from "./types.js";

export interface IdCounters {
  [key: string]: number;
}

export class IdAllocator {
  private counters: IdCounters;
  private readonly filePath: string;

  private constructor(filePath: string, counters: IdCounters) {
    this.filePath = filePath;
    this.counters = counters;
  }

  static load(knowledgeDir: string): IdAllocator {
    const filePath = path.join(knowledgeDir, "counters.json");
    let counters: IdCounters = {};
    if (fs.existsSync(filePath)) {
      counters = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
    return new IdAllocator(filePath, counters);
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.counters, null, 2) + "\n", "utf8");
  }

  /**
   * Allocate the next stable ID for a node type. `domain` is a short
   * uppercase tag (e.g. "AUTH", "DEPS", "STRUCT") and is required for every
   * type except "decision", which is sequential and un-scoped.
   */
  next(type: NodeType, domain?: string): string {
    const prefix = ID_PREFIX_BY_NODE_TYPE[type];

    if (type === "decision") {
      const key = "DEC";
      const n = (this.counters[key] ?? 0) + 1;
      this.counters[key] = n;
      return `DEC-${String(n).padStart(4, "0")}`;
    }

    if (!domain) {
      throw new Error(`IdAllocator.next: a domain tag is required for node type "${type}"`);
    }
    const normalizedDomain = domain.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const key = `${prefix}-${normalizedDomain}`;
    const n = (this.counters[key] ?? 0) + 1;
    this.counters[key] = n;
    const pad = n > 999 ? 4 : 3;
    return `${key}-${String(n).padStart(pad, "0")}`;
  }
}
