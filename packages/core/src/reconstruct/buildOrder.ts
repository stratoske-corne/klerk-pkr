/**
 * Computes a dependency-aware(-ish) build order — ARCHITECTURE.md §4 step 3.
 *
 * Honesty note: true dependency-aware ordering needs `depends_on` /
 * `exposes` / `constrained_by` edges between nodes, and no extraction stage
 * produces edges yet (every KnowledgeEdge array in this codebase is empty
 * today — see ARCHITECTURE.md §0). So this is currently 100% the documented
 * fallback: "canonical phase order when the graph doesn't fully constrain
 * ordering within a phase" — which today means *entirely* phase order,
 * bucketed by node type. When edge extraction lands, this is the seam to
 * add a real topological sort within each phase.
 */

import type { KnowledgeNode, NodeType } from "../types.js";

export interface BuildPhase {
  name: string;
  description: string;
  nodes: KnowledgeNode[];
}

const PHASE_DEFINITIONS: Array<{ name: string; description: string; types: NodeType[] }> = [
  {
    name: "1. Initialize repository & configure runtime",
    description: "Set up the project skeleton, language, and toolchain implied by these tech choices and dependencies.",
    types: ["tech-choice", "dependency", "convention"],
  },
  {
    name: "2. Define the data model",
    description: "Create the database schema and core domain entities.",
    types: ["db-table", "domain-concept"],
  },
  {
    name: "3. Implement components",
    description: "Build the major components/boundaries identified in the architecture.",
    types: ["component", "boundary", "deployment-unit"],
  },
  {
    name: "4. Integrate external services",
    description: "Wire up third-party services and event flows.",
    types: ["external-service", "event"],
  },
  {
    name: "5. Implement APIs",
    description: "Implement the HTTP endpoints / interface surface.",
    types: ["api-endpoint"],
  },
  {
    name: "6. Implement business behavior",
    description: "Encode the business rules, invariants, and edge/error handling the original enforces.",
    types: ["business-rule", "invariant", "edge-case", "error-behavior"],
  },
  {
    name: "7. Validate",
    description: "Run the acceptance checks in ACCEPTANCE_TESTS.md against what was built.",
    types: [],
  },
];

export function computeBuildOrder(nodes: KnowledgeNode[]): BuildPhase[] {
  const phases: BuildPhase[] = [];
  for (const def of PHASE_DEFINITIONS) {
    const phaseNodes = nodes
      .filter((n) => def.types.includes(n.type))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (phaseNodes.length === 0 && def.types.length > 0) continue; // don't render empty phases
    phases.push({ name: def.name, description: def.description, nodes: phaseNodes });
  }
  return phases;
}
