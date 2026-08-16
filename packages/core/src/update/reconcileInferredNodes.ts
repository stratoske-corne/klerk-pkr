/**
 * Turns a stage-6 `supersedes` claim (extract/synthesize.ts's
 * `SupersedeClaim`, already verified against what the model was actually
 * shown) into real edges against the store — the LLM-side counterpart to
 * `mergeNodes.ts`'s deterministic reconciliation, designed in
 * ARCHITECTURE.md §19 after §16 Run 4 found a real, visible bug: a
 * `pkr update --llm` run correctly proposed a *new*, correct fact but left
 * the *old*, now-wrong one sitting in the same rendered file with no
 * relationship recorded — a live contradiction, not just a stale omission.
 *
 * Deliberately reuses the confirmed-node-protection pattern from
 * `mergeNodes.ts` verbatim rather than inventing a parallel one: a
 * confirmed target is never hidden or touched, only linked via
 * `conflicts_with` for a human to resolve; a non-confirmed target gets a
 * `supersedes` edge and stays in the store (render.ts is what actually
 * hides it from the main knowledge files — see there for why deletion was
 * rejected).
 *
 * No claim here is ever invented by this module — every target ID already
 * passed `synthesizeProductAndBehavior`'s "was this ID actually shown to the
 * model" check before it became a `SupersedeClaim`. The lookups below are a
 * second, defensive check (the store shouldn't have moved between synthesis
 * and reconciliation, but this module never assumes that).
 */

import type { FileNodeStore } from "../store/fileNodeStore.js";
import type { SupersedeClaim } from "../extract/synthesize.js";
import type { KnowledgeNode } from "../types.js";

export interface InferredReconcileReport {
  /** New node -> non-confirmed target it replaces. Target stays in the store; render.ts excludes it from the normal section files. */
  superseded: Array<{ newNode: KnowledgeNode; target: KnowledgeNode }>;
  /** New node -> confirmed target it contradicts. Target is completely untouched — surfaced for a human, same as a deterministic conflict. */
  conflicts: Array<{ newNode: KnowledgeNode; target: KnowledgeNode }>;
}

function edgeId(sourceId: string, relationship: string, targetId: string): string {
  return `${sourceId}--${relationship}--${targetId}`;
}

export function reconcileInferredNodes(
  store: FileNodeStore,
  projectId: string,
  newNodes: KnowledgeNode[],
  claims: SupersedeClaim[],
): InferredReconcileReport {
  const report: InferredReconcileReport = { superseded: [], conflicts: [] };
  const newNodesById = new Map(newNodes.map((n) => [n.id, n]));

  for (const claim of claims) {
    const newNode = newNodesById.get(claim.nodeId);
    if (!newNode) continue; // defensive — the claim came from this same synthesis call, so this node should always exist

    for (const targetId of claim.targets) {
      const target = store.getNode(targetId);
      if (!target) continue; // defensive — see module doc

      if (target.status === "confirmed") {
        store.upsertEdge({
          id: edgeId(newNode.id, "conflicts_with", target.id),
          project_id: projectId,
          source_node: newNode.id,
          target_node: target.id,
          relationship_type: "conflicts_with",
          created_at: new Date().toISOString(),
        });
        report.conflicts.push({ newNode, target });
      } else {
        store.upsertEdge({
          id: edgeId(newNode.id, "supersedes", target.id),
          project_id: projectId,
          source_node: newNode.id,
          target_node: target.id,
          relationship_type: "supersedes",
          created_at: new Date().toISOString(),
        });
        report.superseded.push({ newNode, target });
      }
    }
  }

  return report;
}
