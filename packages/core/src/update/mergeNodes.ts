/**
 * Merges freshly re-extracted deterministic facts into the existing store —
 * the heart of `pkr update`. Three things this must get right, in order of
 * importance:
 *
 *  1. Confirmed knowledge is never silently modified or deleted
 *     (PKR_SPEC.md §4.2) — a contradiction becomes a conflict, not a rewrite.
 *  2. A fact that didn't actually change keeps its ID and isn't touched —
 *     re-running `pkr update` with no relevant code changes must be a no-op
 *     on the node graph, not a churn of fresh IDs.
 *  3. Everything is reported as a semantic fact-level change (added/modified/
 *     removed/conflict), not a text diff — PROMPT §9's Knowledge Diff idea.
 */

import type { KnowledgeNode, NodeType } from "../types.js";
import type { IdAllocator } from "../ids.js";
import { FileNodeStore, ConfirmedNodeOverwriteError } from "../store/fileNodeStore.js";
import { makeNode } from "../node-factory.js";
import { naturalKey, NATURAL_KEY_TYPES } from "./naturalKey.js";

export interface NodeMergeReport {
  added: KnowledgeNode[];
  modified: Array<{ before: KnowledgeNode; after: KnowledgeNode }>;
  removed: KnowledgeNode[];
  conflicts: Array<{ existing: KnowledgeNode; candidate: KnowledgeNode }>;
  unchangedCount: number;
}

/** IDs look like `<PREFIX>-<DOMAIN>-<NNN>`; recover the domain segment to reuse for a freshly-allocated ID. */
function extractDomainFromId(id: string): string {
  const parts = id.split("-");
  return parts.slice(1, -1).join("-") || "GENERAL";
}

function contentEquivalent(a: KnowledgeNode, b: KnowledgeNode): boolean {
  return a.title === b.title && a.content === b.content && JSON.stringify(a.evidence) === JSON.stringify(b.evidence);
}

/**
 * `candidates` are the output of a *fresh, throwaway-ID* extraction pass
 * (stages 2-4) — see update/index.ts. Their IDs are disposable; this
 * function either discards them (unchanged), reuses an existing ID
 * (modified), or allocates a real one from `allocator` (genuinely new).
 */
export function mergeDeterministicNodes(
  store: FileNodeStore,
  allocator: IdAllocator,
  projectId: string,
  candidates: KnowledgeNode[],
): NodeMergeReport {
  const report: NodeMergeReport = { added: [], modified: [], removed: [], conflicts: [], unchangedCount: 0 };

  const oldNodesByType = new Map<NodeType, KnowledgeNode[]>();
  for (const type of NATURAL_KEY_TYPES) oldNodesByType.set(type, store.listNodes({ type }));

  const matchedOldIds = new Set<string>();

  for (const candidate of candidates) {
    const oldNodes = oldNodesByType.get(candidate.type) ?? [];
    const key = naturalKey(candidate);
    const existing = oldNodes.find((n) => naturalKey(n) === key);

    if (!existing) {
      const domain = extractDomainFromId(candidate.id);
      const fresh = makeNode(allocator, projectId, domain, {
        type: candidate.type,
        title: candidate.title,
        content: candidate.content,
        status: candidate.status,
        confidence: candidate.confidence,
        evidence: candidate.evidence,
      });
      store.upsertNode(fresh);
      report.added.push(fresh);
      continue;
    }

    matchedOldIds.add(existing.id);

    if (contentEquivalent(existing, candidate)) {
      report.unchangedCount++;
      continue;
    }

    // Deliberately NOT spreading existing's status/confidence/confirmed_by
    // forward: `updated` represents what fresh extraction currently says,
    // which is always `observed` with `confirmed_by: null` (extractors never
    // set either). If we let those fields leak from `existing`, a confirmed
    // node's `confirmed_by: "human"` would ride along on the merged node and
    // silently defeat FileNodeStore.upsertNode's protection check below —
    // this exact bug shipped once and was caught by the update/index.ts test.
    const updated: KnowledgeNode = {
      ...existing,
      title: candidate.title,
      content: candidate.content,
      status: candidate.status,
      confidence: candidate.confidence,
      confirmed_by: candidate.confirmed_by,
      evidence: candidate.evidence,
      updated_at: new Date().toISOString(),
    };

    try {
      store.upsertNode(updated);
      report.modified.push({ before: existing, after: updated });
    } catch (err) {
      if (!(err instanceof ConfirmedNodeOverwriteError)) throw err;
      const domain = extractDomainFromId(candidate.id);
      const conflictNode = makeNode(allocator, projectId, domain, {
        type: candidate.type,
        title: candidate.title,
        content: candidate.content,
        status: candidate.status,
        confidence: candidate.confidence,
        evidence: candidate.evidence,
      });
      store.upsertNode(conflictNode);
      store.upsertEdge({
        id: `${conflictNode.id}--conflicts_with--${existing.id}`,
        project_id: projectId,
        source_node: conflictNode.id,
        target_node: existing.id,
        relationship_type: "conflicts_with",
        created_at: new Date().toISOString(),
      });
      report.conflicts.push({ existing, candidate: conflictNode });
    }
  }

  for (const oldNodes of oldNodesByType.values()) {
    for (const old of oldNodes) {
      if (matchedOldIds.has(old.id)) continue;
      if (old.status === "confirmed") {
        // Extraction no longer reproduces this confirmed fact — could be a
        // genuine removal, could be an extractor gap. Never auto-delete
        // confirmed knowledge; surface it for a human to resolve instead.
        report.conflicts.push({ existing: old, candidate: old });
        continue;
      }
      store.deleteNode(old.id);
      report.removed.push(old);
    }
  }

  return report;
}
