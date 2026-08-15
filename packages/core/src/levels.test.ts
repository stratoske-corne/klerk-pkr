import { describe, it, expect } from "vitest";
import { computeAchievableLevel, groupByType } from "./levels.js";
import type { KnowledgeNode, NodeType } from "./types.js";

/** Minimal fake node — computeAchievableLevel only ever looks at `.type` via the grouped map. */
function fakeNodesOf(...types: NodeType[]): KnowledgeNode[] {
  return types.map((type) => ({ type } as KnowledgeNode));
}

describe("computeAchievableLevel", () => {
  it("is 0 with no product-layer nodes at all", () => {
    const nodesByType = groupByType(fakeNodesOf("dependency", "component"));
    expect(computeAchievableLevel({ nodesByType, hasReconstructionArtifacts: false })).toBe(0);
  });

  it("is 1 with a product node but no requirement+user-flow+behavior triad", () => {
    const nodesByType = groupByType(fakeNodesOf("domain-concept"));
    expect(computeAchievableLevel({ nodesByType, hasReconstructionArtifacts: false })).toBe(1);
  });

  it("is 2 once requirement+user-flow+behavior exist but architecture/db-table are missing", () => {
    const nodesByType = groupByType(fakeNodesOf("requirement", "user-flow", "business-rule"));
    expect(computeAchievableLevel({ nodesByType, hasReconstructionArtifacts: false })).toBe(2);
  });

  it("is 3 once architecture+db-table exist but implementation/api-endpoint or reconstruction artifacts are missing", () => {
    const nodesByType = groupByType(fakeNodesOf("requirement", "user-flow", "business-rule", "component", "db-table"));
    expect(computeAchievableLevel({ nodesByType, hasReconstructionArtifacts: false })).toBe(3);
  });

  it("never claims level 4 or 5 without hasReconstructionArtifacts, even with every other node type present", () => {
    const nodesByType = groupByType(
      fakeNodesOf("requirement", "user-flow", "business-rule", "component", "db-table", "tech-choice", "api-endpoint"),
    );
    expect(computeAchievableLevel({ nodesByType, hasReconstructionArtifacts: false })).toBe(3);
  });

  it("jumps straight to level 5 once every condition plus hasReconstructionArtifacts holds (current behavior: level 4 is unreachable as an output — both level 4 and 5 gate on the same flag, see ARCHITECTURE.md finding)", () => {
    const nodesByType = groupByType(
      fakeNodesOf("requirement", "user-flow", "business-rule", "component", "db-table", "tech-choice", "api-endpoint"),
    );
    expect(computeAchievableLevel({ nodesByType, hasReconstructionArtifacts: true })).toBe(5);
  });
});
