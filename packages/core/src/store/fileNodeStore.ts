/**
 * Local, file-based NodeStore — ARCHITECTURE.md §1 / §7 ("local adapter").
 *
 * Source of truth for a CLI-only project: `.knowledge/nodes.jsonl` and
 * `.knowledge/edges.jsonl`, one JSON object per line, rewritten sorted by ID
 * on every save so `git diff` stays meaningful (PKR_SPEC.md §0, §8).
 *
 * This is intentionally the only storage adapter implemented so far. A
 * hosted (Postgres) adapter can implement the same shape later
 * (ARCHITECTURE.md §7) without this module changing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { KnowledgeNode, KnowledgeEdge, type KnowledgeNode as TNode, type KnowledgeEdge as TEdge } from "../types.js";

export class ConfirmedNodeOverwriteError extends Error {
  constructor(nodeId: string) {
    super(
      `Refusing to overwrite confirmed node "${nodeId}". ` +
        `Confirmed knowledge is protected (PKR_SPEC.md §4.2) — create a conflicting node instead.`,
    );
    this.name = "ConfirmedNodeOverwriteError";
  }
}

export class FileNodeStore {
  private nodes = new Map<string, TNode>();
  private edges = new Map<string, TEdge>();
  private readonly knowledgeDir: string;

  private constructor(knowledgeDir: string) {
    this.knowledgeDir = knowledgeDir;
  }

  static load(knowledgeDir: string): FileNodeStore {
    const store = new FileNodeStore(knowledgeDir);
    store.readJsonl(path.join(knowledgeDir, "nodes.jsonl"), (raw) => {
      const node = KnowledgeNode.parse(raw);
      store.nodes.set(node.id, node);
    });
    store.readJsonl(path.join(knowledgeDir, "edges.jsonl"), (raw) => {
      const edge = KnowledgeEdge.parse(raw);
      store.edges.set(edge.id, edge);
    });
    return store;
  }

  private readJsonl(filePath: string, onEach: (raw: unknown) => void): void {
    if (!fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      onEach(JSON.parse(trimmed));
    }
  }

  /** Insert or replace a node. Refuses to silently overwrite a confirmed node. */
  upsertNode(node: TNode): void {
    const existing = this.nodes.get(node.id);
    if (existing && existing.status === "confirmed" && node.confirmed_by !== "human") {
      throw new ConfirmedNodeOverwriteError(node.id);
    }
    this.nodes.set(node.id, node);
  }

  upsertEdge(edge: TEdge): void {
    this.edges.set(edge.id, edge);
  }

  /**
   * Removes a node — used by `pkr update` when a deterministic fact no
   * longer re-extracts (e.g. a dependency was removed from package.json).
   * Same protection as `upsertNode`: a confirmed node is never silently
   * deleted (PKR_SPEC.md §4.2) — the caller is expected to have already
   * routed confirmed nodes to a conflict instead of calling this.
   */
  deleteNode(id: string): void {
    const existing = this.nodes.get(id);
    if (existing?.status === "confirmed") {
      throw new ConfirmedNodeOverwriteError(id);
    }
    this.nodes.delete(id);
  }

  getNode(id: string): TNode | undefined {
    return this.nodes.get(id);
  }

  listNodes(filter?: { type?: TNode["type"] }): TNode[] {
    const all = [...this.nodes.values()];
    const filtered = filter?.type ? all.filter((n) => n.type === filter.type) : all;
    return filtered.sort((a, b) => a.id.localeCompare(b.id));
  }

  listEdges(): TEdge[] {
    return [...this.edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  save(): void {
    fs.mkdirSync(this.knowledgeDir, { recursive: true });
    this.writeJsonl(
      path.join(this.knowledgeDir, "nodes.jsonl"),
      this.listNodes().map((n) => KnowledgeNode.parse(n)),
    );
    this.writeJsonl(
      path.join(this.knowledgeDir, "edges.jsonl"),
      this.listEdges().map((e) => KnowledgeEdge.parse(e)),
    );
  }

  private writeJsonl(filePath: string, rows: unknown[]): void {
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
    fs.writeFileSync(filePath, text, "utf8");
  }
}
