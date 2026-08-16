/**
 * Small helper so every extraction stage builds nodes the same way: allocate
 * a stable ID (PKR_SPEC.md §5), stamp timestamps, and validate against the
 * KnowledgeNode schema before it ever reaches the store.
 */

import { KnowledgeNode, type NewKnowledgeNode, type KnowledgeNode as TNode, type EvidenceRef, type NodeType } from "./types.js";
import type { IdAllocator } from "./ids.js";

export function makeNode(
  allocator: IdAllocator,
  projectId: string,
  domain: string | undefined,
  input: Omit<NewKnowledgeNode, "project_id">,
): TNode {
  const id = allocator.next(input.type, domain);
  const now = new Date().toISOString();
  const node: TNode = {
    id,
    project_id: projectId,
    type: input.type,
    title: input.title,
    content: input.content,
    status: input.status,
    confidence: input.confidence ?? null,
    confirmed_by: input.confirmed_by ?? null,
    evidence: input.evidence,
    supersedes: input.supersedes ?? null,
    created_at: now,
    updated_at: now,
  };
  return KnowledgeNode.parse(node);
}

/**
 * Structurally forces status: "inferred" with a required confidence — this
 * is what ARCHITECTURE.md §3 means by "stage 6 code paths structurally can
 * only emit inferred nodes." An LLM synthesis call cannot accidentally
 * produce an `observed` node through this helper; only `makeNode` (used by
 * the deterministic stages) can do that.
 */
export function makeInferredNode(
  allocator: IdAllocator,
  projectId: string,
  domain: string | undefined,
  input: {
    type: NodeType;
    title: string;
    content: string;
    confidence: number;
    evidence: EvidenceRef[];
    /** ID of a prior inferred node this one updates/replaces — ARCHITECTURE.md §19 (`pkr update --llm` reconciliation). Verified by the caller before being passed in; this helper trusts it. */
    supersedes?: string | null;
  },
): TNode {
  return makeNode(allocator, projectId, domain, { ...input, status: "inferred" });
}
