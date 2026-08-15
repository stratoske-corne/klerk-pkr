/**
 * Reconstruction level computation — PKR_SPEC.md §3.
 *
 * "A PKR must never claim a level it has no evidence for." This computes the
 * level from what was actually extracted; nothing here is operator-set. In
 * this early slice (no LLM synthesis, no reconstruction/ package yet) the
 * honest answer for most repos will be 0 — that's expected, not a bug.
 */

import type { KnowledgeNode, NodeType } from "./types.js";

const PRODUCT_TYPES: NodeType[] = ["requirement", "user-flow", "domain-concept"];
const BEHAVIOR_TYPES: NodeType[] = ["business-rule", "invariant", "edge-case", "error-behavior"];
const ARCHITECTURE_TYPES: NodeType[] = ["component", "boundary", "deployment-unit"];
const IMPLEMENTATION_TYPES: NodeType[] = ["tech-choice", "convention", "dependency"];

function any(nodesByType: Map<NodeType, KnowledgeNode[]>, types: NodeType[]): boolean {
  return types.some((t) => (nodesByType.get(t)?.length ?? 0) > 0);
}

export function groupByType(nodes: KnowledgeNode[]): Map<NodeType, KnowledgeNode[]> {
  const map = new Map<NodeType, KnowledgeNode[]>();
  for (const node of nodes) {
    if (!map.has(node.type)) map.set(node.type, []);
    map.get(node.type)!.push(node);
  }
  return map;
}

export interface LevelInput {
  nodesByType: Map<NodeType, KnowledgeNode[]>;
  /** True once `pkr reconstruct` has produced `.reconstruction/` artifacts (not yet built — see ARCHITECTURE.md M2). */
  hasReconstructionArtifacts: boolean;
}

export function computeAchievableLevel({ nodesByType, hasReconstructionArtifacts }: LevelInput): number {
  const level1 = any(nodesByType, PRODUCT_TYPES);
  if (!level1) return 0;

  const level2 = level1 && any(nodesByType, ["requirement"]) && any(nodesByType, ["user-flow"]) && any(nodesByType, BEHAVIOR_TYPES);
  if (!level2) return 1;

  const level3 = level2 && any(nodesByType, ARCHITECTURE_TYPES) && any(nodesByType, ["db-table"]);
  if (!level3) return 2;

  const level4 =
    level3 && any(nodesByType, IMPLEMENTATION_TYPES) && any(nodesByType, ["api-endpoint"]) && hasReconstructionArtifacts;
  if (!level4) return 3;

  // Level 5 additionally requires machine-checkable validation criteria,
  // which only exist once the reconstruction package (M2) is built.
  const level5 = level4 && hasReconstructionArtifacts;
  return level5 ? 5 : 4;
}
