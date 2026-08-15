/**
 * `pkr update` needs to recognize "this is the same fact as before" across
 * two independent extraction runs whose IDs aren't guaranteed to line up
 * (IDs are allocator-assigned, not content-derived). A natural key is a
 * best-effort, deterministic-stage-only identity: stable enough in practice
 * because our stage 2-4 extractors already produce stable titles for the
 * same underlying fact (PKR_SPEC.md §5 domain — this is the pragmatic
 * MVP substitute for it).
 *
 * Only applies to deterministic node types (dependency, tech-choice,
 * convention, component, boundary, deployment-unit, api-endpoint, db-table,
 * event, external-service). Stage 6 (inferred) types are handled separately
 * by `pkr update` — see update/index.ts — because their titles aren't
 * guaranteed stable across LLM calls the way a directory path or a package
 * name is.
 */

import type { KnowledgeNode, NodeType } from "../types.js";

export const NATURAL_KEY_TYPES: NodeType[] = [
  "dependency",
  "tech-choice",
  "convention",
  "component",
  "boundary",
  "deployment-unit",
  "api-endpoint",
  "db-table",
  "event",
  "external-service",
];

/**
 * `dependency` titles embed the version range ("zod (^3.23.8)"), so a bare
 * version bump would otherwise look like "removed zod, added zod" instead of
 * "modified zod" — strip it back to the package name for identity purposes.
 */
export function naturalKey(node: KnowledgeNode): string {
  if (node.type === "dependency") {
    const match = /^(.+?)\s+\(/.exec(node.title);
    return match ? match[1] : node.title;
  }
  return node.title;
}
