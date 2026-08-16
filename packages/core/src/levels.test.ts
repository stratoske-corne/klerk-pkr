import { describe, it, expect } from "vitest";
import { computeAchievableLevel, groupByType } from "./levels.js";
import type { KnowledgeNode, NodeType } from "./types.js";

/** Minimal fake node — computeAchievableLevel only ever looks at `.type` via the grouped map. */
function fakeNodesOf(...types: NodeType[]): KnowledgeNode[] {
  return types.map((type) => ({ type } as KnowledgeNode));
}

const fullNodeSet = () =>
  groupByType(fakeNodesOf("requirement", "user-flow", "business-rule", "component", "db-table", "tech-choice", "api-endpoint"));

describe("computeAchievableLevel", () => {
  it("is 0 with no product-layer nodes at all", () => {
    const nodesByType = groupByType(fakeNodesOf("dependency", "component"));
    expect(computeAchievableLevel({ nodesByType, hasReconstructionArtifacts: false, hasValidationCriteria: false })).toBe(0);
  });

  it("is 1 with a product node but no requirement+user-flow+behavior triad", () => {
    const nodesByType = groupByType(fakeNodesOf("domain-concept"));
    expect(computeAchievableLevel({ nodesByType, hasReconstructionArtifacts: false, hasValidationCriteria: false })).toBe(1);
  });

  it("is 2 once requirement+user-flow+behavior exist but architecture/db-table are missing", () => {
    const nodesByType = groupByType(fakeNodesOf("requirement", "user-flow", "business-rule"));
    expect(computeAchievableLevel({ nodesByType, hasReconstructionArtifacts: false, hasValidationCriteria: false })).toBe(2);
  });

  it("is 3 once architecture+db-table exist but implementation/api-endpoint or reconstruction artifacts are missing", () => {
    const nodesByType = groupByType(fakeNodesOf("requirement", "user-flow", "business-rule", "component", "db-table"));
    expect(computeAchievableLevel({ nodesByType, hasReconstructionArtifacts: false, hasValidationCriteria: false })).toBe(3);
  });

  it("never claims level 4 or 5 without hasReconstructionArtifacts, even with every other node type present", () => {
    expect(computeAchievableLevel({ nodesByType: fullNodeSet(), hasReconstructionArtifacts: false, hasValidationCriteria: true })).toBe(3);
  });

  it("REGRESSION: level 4 is a genuinely reachable, distinct output — reconstruction artifacts present, but no machine-checkable validation criteria yet (§18 fix)", () => {
    expect(computeAchievableLevel({ nodesByType: fullNodeSet(), hasReconstructionArtifacts: true, hasValidationCriteria: false })).toBe(4);
  });

  it("is 5 only once hasValidationCriteria is ALSO true, distinct from hasReconstructionArtifacts", () => {
    expect(computeAchievableLevel({ nodesByType: fullNodeSet(), hasReconstructionArtifacts: true, hasValidationCriteria: true })).toBe(5);
  });

  it("does not claim 5 from hasValidationCriteria alone, without hasReconstructionArtifacts (level 4's own gate)", () => {
    expect(computeAchievableLevel({ nodesByType: fullNodeSet(), hasReconstructionArtifacts: false, hasValidationCriteria: true })).toBe(3);
  });
});
