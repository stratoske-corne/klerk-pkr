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
  /** True once `pkr reconstruct` has produced `.reconstruction/` artifacts (deterministic-constraints.md etc. — PKR_SPEC.md §3 level 4's own requirement). */
  hasReconstructionArtifacts: boolean;
  /**
   * True only when the reconstruction package's acceptance criteria are
   * machine-checkable per PKR_SPEC.md §3 level 5 specifically — build/test
   * commands, an endpoint list, a schema list, sufficient for `pkr compare`
   * to score without human judgment. NOT the same thing as
   * `hasReconstructionArtifacts` (a package existing at all) — the two used
   * to be the same flag, which made level 4 impossible to ever observe as
   * an output (whatever satisfied level 4's own reconstruction-artifacts
   * condition automatically satisfied level 5 too — ARCHITECTURE.md §18
   * finding, fixed here by requiring a genuinely distinct signal).
   */
  hasValidationCriteria: boolean;
}

export function computeAchievableLevel({ nodesByType, hasReconstructionArtifacts, hasValidationCriteria }: LevelInput): number {
  const level1 = any(nodesByType, PRODUCT_TYPES);
  if (!level1) return 0;

  const level2 = level1 && any(nodesByType, ["requirement"]) && any(nodesByType, ["user-flow"]) && any(nodesByType, BEHAVIOR_TYPES);
  if (!level2) return 1;

  const level3 = level2 && any(nodesByType, ARCHITECTURE_TYPES) && any(nodesByType, ["db-table"]);
  if (!level3) return 2;

  const level4 =
    level3 && any(nodesByType, IMPLEMENTATION_TYPES) && any(nodesByType, ["api-endpoint"]) && hasReconstructionArtifacts;
  if (!level4) return 3;

  const level5 = level4 && hasValidationCriteria;
  return level5 ? 5 : 4;
}
