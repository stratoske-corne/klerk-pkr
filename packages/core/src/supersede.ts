/**
 * Shared "which nodes are superseded and should be excluded from primary
 * rendering" logic — ARCHITECTURE.md §19. Pulled out as its own module
 * because it was found living only inside `render/render.ts`, duplicated
 * nowhere — which is exactly how `context/render.ts` (the continuation
 * package an AI agent actually reads) ended up not filtering superseded
 * nodes at all: it never even received `edges` in the first place, so the
 * same $500-vs-$1,000-style contradiction §16 Run 4 found in the main PKR
 * files was still fully reproducible in `pkr context`'s output after that
 * fix shipped. One source of truth now, used by both.
 *
 * A confirmed target is never included here — same rule everywhere in this
 * codebase (`FileNodeStore.upsertNode`, `mergeNodes.ts`): a human has to see
 * and resolve a confirmed conflict, nothing about it is ever hidden.
 */

import type { KnowledgeNode, KnowledgeEdge } from "./types.js";

export function computeSupersededIds(nodes: KnowledgeNode[], edges: KnowledgeEdge[]): Set<string> {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  return new Set(
    edges
      .filter((e) => e.relationship_type === "supersedes")
      .map((e) => e.target_node)
      .filter((id) => nodesById.get(id)?.status !== "confirmed"),
  );
}
