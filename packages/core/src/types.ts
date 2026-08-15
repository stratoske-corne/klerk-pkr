/**
 * Core knowledge-graph types, mirroring PKR_SPEC.md §4/§6/§2.
 *
 * These are the single source of truth for the shape of a fact. The CLI, the
 * render pipeline, and (eventually) the API/DB layer all import from here —
 * see ARCHITECTURE.md §8 ("never drift into three different shapes").
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Node types — PKR_SPEC.md §4 / §5 (prefix table)
// ---------------------------------------------------------------------------

export const NodeType = z.enum([
  // product/
  "requirement",
  "user-flow",
  "domain-concept",
  // architecture/
  "component",
  "boundary",
  "deployment-unit",
  // implementation/
  "tech-choice",
  "convention",
  "dependency",
  // interfaces/
  "api-endpoint",
  "db-table",
  "event",
  "external-service",
  // behavior/
  "business-rule",
  "invariant",
  "edge-case",
  "error-behavior",
  // decisions/
  "decision",
]);
export type NodeType = z.infer<typeof NodeType>;

/** PKR_SPEC.md §5 — stable ID prefix per node type. */
export const ID_PREFIX_BY_NODE_TYPE: Record<NodeType, string> = {
  requirement: "REQ",
  "user-flow": "FLOW",
  "domain-concept": "DOM",
  component: "ARCH",
  boundary: "ARCH",
  "deployment-unit": "ARCH",
  "tech-choice": "TECH",
  convention: "TECH",
  dependency: "TECH",
  "api-endpoint": "API",
  "db-table": "DB",
  event: "EVT",
  "external-service": "EXT",
  "business-rule": "RULE",
  invariant: "RULE",
  "edge-case": "RULE",
  "error-behavior": "RULE",
  decision: "DEC",
};

// ---------------------------------------------------------------------------
// Status / confidence — PKR_SPEC.md §4.1
// ---------------------------------------------------------------------------

export const NodeStatus = z.enum([
  "observed",
  "inferred",
  "confirmed",
  "unknown",
  "historical-lost",
]);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const EvidenceRef = z.object({
  path: z.string(),
  symbol: z.string().optional(),
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  commit: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const KnowledgeNode = z
  .object({
    id: z.string(),
    project_id: z.string(),
    type: NodeType,
    title: z.string(),
    content: z.string(),
    status: NodeStatus,
    confidence: z.number().min(0).max(1).nullable(),
    confirmed_by: z.literal("human").nullable(),
    evidence: z.array(EvidenceRef),
    supersedes: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .superRefine((node, ctx) => {
    // PKR_SPEC.md §4.1 status/confidence/evidence rules, enforced at the type
    // boundary rather than left to convention (ARCHITECTURE.md §3).
    if (node.status === "inferred" && node.confidence === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status 'inferred' requires a non-null confidence",
        path: ["confidence"],
      });
    }
    if (node.status !== "inferred" && node.confidence !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "confidence must be null unless status is 'inferred'",
        path: ["confidence"],
      });
    }
    if ((node.status === "observed" || node.status === "inferred") && node.evidence.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `status '${node.status}' requires at least one evidence reference`,
        path: ["evidence"],
      });
    }
  });
export type KnowledgeNode = z.infer<typeof KnowledgeNode>;

/** Convenience input type before defaulted/derived fields are filled in. */
export type NewKnowledgeNode = Omit<
  KnowledgeNode,
  "id" | "created_at" | "updated_at" | "confirmed_by" | "supersedes"
> &
  Partial<Pick<KnowledgeNode, "confirmed_by" | "supersedes">>;

// ---------------------------------------------------------------------------
// Edges — PKR_SPEC.md §6
// ---------------------------------------------------------------------------

export const RelationshipType = z.enum([
  "implements",
  "depends_on",
  "constrained_by",
  "exposes",
  "tested_by",
  "derived_from",
  "supersedes",
  "conflicts_with",
]);
export type RelationshipType = z.infer<typeof RelationshipType>;

export const KnowledgeEdge = z.object({
  id: z.string(),
  project_id: z.string(),
  source_node: z.string(),
  target_node: z.string(),
  relationship_type: RelationshipType,
  evidence: z.array(EvidenceRef).optional(),
  created_at: z.string(),
});
export type KnowledgeEdge = z.infer<typeof KnowledgeEdge>;

export type NewKnowledgeEdge = Omit<KnowledgeEdge, "id" | "created_at">;

// ---------------------------------------------------------------------------
// Manifest — PKR_SPEC.md §2
// ---------------------------------------------------------------------------

export const Manifest = z.object({
  schema_version: z.literal("0.1"),
  project: z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
  knowledge: z.object({
    generated_at: z.string(),
    source_commit: z.string().nullable(),
    generator_version: z.string(),
    knowledge_version: z.string(),
  }),
  reconstruction: z.object({
    // 0 = no level achieved yet (e.g. a deterministic-only export with no
    // product/behavior layer). Never set above what PKR_SPEC.md §3 evidence
    // requirements actually support — computed, not operator-set.
    target_level: z.number().int().min(0).max(5),
  }),
  sections: z.record(z.string(), z.boolean()),
  validation: z
    .object({
      commands: z.record(z.string(), z.string()).optional(),
      expected_endpoints: z.array(z.string()).optional(),
      expected_tables: z.array(z.string()).optional(),
    })
    .optional(),
  integrity: z.object({
    node_count: z.number().int().nonnegative(),
    edge_count: z.number().int().nonnegative(),
    nodes_hash: z.string(),
  }),
});
export type Manifest = z.infer<typeof Manifest>;
