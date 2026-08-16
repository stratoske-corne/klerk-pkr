/**
 * Stage 7 — Render & write. ARCHITECTURE.md §2 stage 7.
 *
 * Turns the node/edge graph into the portable `.projectknowledge/` tree
 * (PKR_SPEC.md §1). Deterministic given the same node set. Runs the secret
 * write-gate (PKR_SPEC.md §10) on every piece of content before it touches
 * disk. Only creates files that have content — "do not blindly generate all
 * files" (PKR_SPEC.md §1).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import type { KnowledgeNode, KnowledgeEdge, Manifest, NodeType } from "../types.js";
import { redactSecrets, type SecretMatch } from "../secrets.js";
import { computeAchievableLevel, groupByType } from "../levels.js";
import { computeSupersededIds } from "../supersede.js";

export interface FileTarget {
  dir: string;
  file: string;
  heading: string;
}

/**
 * PKR_SPEC.md §1 — which file a node type renders into. `decision` is
 * handled separately (one file per node). This mapping is a bijection (every
 * type maps to exactly one file, no file hosts more than one type) — the
 * reconstruction module's markdown-fallback parser (reconstruct/loadPkr.ts)
 * relies on that to invert it and recover a node's type from its file path
 * when `.knowledge/*.jsonl` isn't available (PKR_SPEC.md §8 portability).
 */
export const NODE_TYPE_TARGET: Partial<Record<NodeType, FileTarget>> = {
  requirement: { dir: "product", file: "requirements.md", heading: "Requirements" },
  "user-flow": { dir: "product", file: "user-flows.md", heading: "User Flows" },
  "domain-concept": { dir: "product", file: "domain-model.md", heading: "Domain Model" },

  component: { dir: "architecture", file: "components.md", heading: "Components" },
  boundary: { dir: "architecture", file: "boundaries.md", heading: "Boundaries" },
  "deployment-unit": { dir: "architecture", file: "deployment.md", heading: "Deployment" },

  "tech-choice": { dir: "implementation", file: "technology-stack.md", heading: "Technology Stack" },
  convention: { dir: "implementation", file: "coding-conventions.md", heading: "Coding Conventions" },
  dependency: { dir: "implementation", file: "dependencies.md", heading: "Dependencies" },

  "api-endpoint": { dir: "interfaces", file: "api-contracts.md", heading: "API Contracts" },
  "db-table": { dir: "interfaces", file: "database-schema.md", heading: "Database Schema" },
  event: { dir: "interfaces", file: "events.md", heading: "Events" },
  "external-service": { dir: "interfaces", file: "external-services.md", heading: "External Services" },

  "business-rule": { dir: "behavior", file: "business-rules.md", heading: "Business Rules" },
  invariant: { dir: "behavior", file: "invariants.md", heading: "Invariants" },
  "edge-case": { dir: "behavior", file: "edge-cases.md", heading: "Edge Cases" },
  "error-behavior": { dir: "behavior", file: "error-behavior.md", heading: "Error Behavior" },
};

function renderEvidence(node: KnowledgeNode): string {
  if (node.evidence.length === 0) return "";
  const lines = node.evidence.map((e) => {
    const loc = e.lines ? `:${e.lines[0]}-${e.lines[1]}` : "";
    const symbol = e.symbol ? `::${e.symbol}` : "";
    return `- ${e.path}${loc}${symbol}`;
  });
  return `\nEvidence:\n${lines.join("\n")}\n`;
}

function renderNodeSection(node: KnowledgeNode, redactions: SecretMatch[]): string {
  const parts = [`### ${node.title} \`${node.id}\``, "", `Status: ${node.status}`];
  if (node.status === "inferred") {
    parts.push(`Confidence: ${node.confidence!.toFixed(2)}`);
  }
  if (node.status === "confirmed") {
    parts.push(`Confirmed by: human`);
  }
  parts.push("", node.content.trim(), renderEvidence(node).trimEnd());
  if (redactions.length > 0) {
    parts.push("", `> ⚠ ${redactions.length} likely secret value(s) were detected and redacted from this content before export.`);
  }
  return parts.join("\n").trimEnd() + "\n";
}

function renderFile(target: FileTarget, nodes: KnowledgeNode[], generatedAt: string): { content: string; redactions: SecretMatch[] } {
  const allRedactions: SecretMatch[] = [];
  const sections = nodes.map((raw) => {
    const titleRedacted = redactSecrets(raw.title);
    const contentRedacted = redactSecrets(raw.content);
    allRedactions.push(...titleRedacted.redactions, ...contentRedacted.redactions);
    const clean: KnowledgeNode = { ...raw, title: titleRedacted.text, content: contentRedacted.text };
    return renderNodeSection(clean, [...titleRedacted.redactions, ...contentRedacted.redactions]);
  });

  const frontMatter = [
    "---",
    "generated_by: pkr-cli",
    `generated_at: ${generatedAt}`,
    `node_ids: [${nodes.map((n) => n.id).join(", ")}]`,
    "---",
    "",
  ].join("\n");

  const content = `${frontMatter}# ${target.heading}\n\n${sections.join("\n")}`;
  return { content, redactions: allRedactions };
}

export interface RenderInput {
  outDir: string; // absolute path to .projectknowledge
  projectName: string;
  projectDescription?: string | null;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  sourceCommit: string | null;
  generatorVersion: string;
  knowledgeVersion: string;
  validationCommands?: Record<string, string>;
}

export interface RenderResult {
  writtenFiles: string[];
  totalRedactions: number;
  achievedLevel: number;
}

function writeFile(outDir: string, relPath: string, content: string, written: string[]): void {
  const abs = path.join(outDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content.endsWith("\n") ? content : content + "\n", "utf8");
  written.push(relPath);
}

export function renderProjectKnowledge(input: RenderInput): RenderResult {
  const generatedAt = new Date().toISOString();
  const written: string[] = [];
  let totalRedactions = 0;

  // ARCHITECTURE.md §19 — a node that's the target of a `supersedes` edge is
  // excluded from its normal section file (see supersede.ts for the shared
  // confirmed-node exception). Excluded here, not deleted from the store:
  // still present in `.knowledge/*.jsonl` and rendered into `superseded.md`
  // below, so the audit trail survives a portability copy that only ever
  // sees the rendered Markdown (PKR_SPEC.md §8).
  const nodesById = new Map(input.nodes.map((n) => [n.id, n]));
  const supersededIds = computeSupersededIds(input.nodes, input.edges);

  // --- group nodes by target file, skip decisions (rendered per-node) ----
  const byFile = new Map<string, { target: FileTarget; nodes: KnowledgeNode[] }>();
  const decisionNodes = input.nodes.filter((n) => n.type === "decision" && !supersededIds.has(n.id));
  for (const node of input.nodes) {
    if (node.type === "decision" || supersededIds.has(node.id)) continue;
    const target = NODE_TYPE_TARGET[node.type];
    if (!target) continue;
    const key = `${target.dir}/${target.file}`;
    if (!byFile.has(key)) byFile.set(key, { target, nodes: [] });
    byFile.get(key)!.nodes.push(node);
  }

  const sectionsPresent: Record<string, boolean> = {
    product: false,
    architecture: false,
    implementation: false,
    interfaces: false,
    behavior: false,
    decisions: false,
    superseded: false,
  };

  for (const [relPath, { target, nodes }] of [...byFile.entries()].sort()) {
    const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    const { content, redactions } = renderFile(target, sorted, generatedAt);
    writeFile(input.outDir, relPath, content, written);
    totalRedactions += redactions.length;
    sectionsPresent[target.dir] = true;
  }

  for (const node of decisionNodes) {
    const slug = node.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const { text: title, redactions: r1 } = redactSecrets(node.title);
    const { text: content, redactions: r2 } = redactSecrets(node.content);
    totalRedactions += r1.length + r2.length;
    const body = [
      "---",
      "generated_by: pkr-cli",
      `generated_at: ${generatedAt}`,
      `node_ids: [${node.id}]`,
      "---",
      "",
      `# ${title}`,
      "",
      `Status: ${node.status}`,
      "",
      content.trim(),
      renderEvidence({ ...node, title, content }).trimEnd(),
    ]
      .join("\n")
      .trimEnd();
    writeFile(input.outDir, `decisions/${node.id}-${slug}.md`, body + "\n", written);
    sectionsPresent.decisions = true;
  }

  // --- superseded (ARCHITECTURE.md §19) -------------------------------------
  if (supersededIds.size > 0) {
    const supersededBy = new Map<string, KnowledgeNode[]>(); // target id -> the new node(s) that superseded it
    for (const edge of input.edges) {
      if (edge.relationship_type !== "supersedes" || !supersededIds.has(edge.target_node)) continue;
      const source = nodesById.get(edge.source_node);
      if (!source) continue;
      if (!supersededBy.has(edge.target_node)) supersededBy.set(edge.target_node, []);
      supersededBy.get(edge.target_node)!.push(source);
    }

    const byHeading = new Map<string, KnowledgeNode[]>();
    for (const id of supersededIds) {
      const node = nodesById.get(id);
      if (!node) continue;
      const heading = NODE_TYPE_TARGET[node.type]?.heading ?? "Other";
      if (!byHeading.has(heading)) byHeading.set(heading, []);
      byHeading.get(heading)!.push(node);
    }

    const sections: string[] = [];
    let supersededRedactions = 0;
    for (const [heading, nodes] of [...byHeading.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      sections.push(`## ${heading}`, "");
      for (const raw of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
        const titleRedacted = redactSecrets(raw.title);
        const contentRedacted = redactSecrets(raw.content);
        supersededRedactions += titleRedacted.redactions.length + contentRedacted.redactions.length;
        const clean: KnowledgeNode = { ...raw, title: titleRedacted.text, content: contentRedacted.text };
        const replacedBy = (supersededBy.get(raw.id) ?? [])
          .map((n) => `\`${n.title}\` \`${n.id}\``)
          .join(", ");
        sections.push(
          renderNodeSection(clean, [...titleRedacted.redactions, ...contentRedacted.redactions]).trimEnd(),
          replacedBy ? `\n→ superseded by ${replacedBy}\n` : "",
        );
      }
    }

    const frontMatter = ["---", "generated_by: pkr-cli", `generated_at: ${generatedAt}`, "---", ""].join("\n");
    const intro = [
      "# Superseded Knowledge",
      "",
      "Facts that a later analysis replaced or corrected. Kept here rather than deleted —",
      "PKR_SPEC.md §8's portability guarantee and §4.2's audit-trail principle both apply",
      "to inferred knowledge, not just deterministic facts. Not shown in the main section",
      "files above, so current knowledge doesn't sit next to what it replaced.",
      "",
    ].join("\n");
    writeFile(input.outDir, "superseded.md", `${frontMatter}${intro}\n${sections.join("\n")}`, written);
    totalRedactions += supersededRedactions;
    sectionsPresent.superseded = true;
  }

  // --- traceability --------------------------------------------------------
  // `JSON.stringify(obj, keysArray, indent)` does NOT mean "sort these keys" —
  // the second argument is a property allowlist applied at every nesting
  // level, not just the top one. Passing top-level keys as that allowlist
  // silently strips any *nested* object down to `{}`, since none of its own
  // property names (e.g. "target", "relationship_type") are in the list.
  // `source-map.json` never showed this (its values are arrays of plain
  // strings, and array elements aren't filtered by the allowlist) but
  // `knowledge-map.json` did the moment this codebase produced its first-ever
  // non-empty edge list — every entry silently became `{}`. Found via a real
  // `pkr update --llm` call (ARCHITECTURE.md §19/§16 Run 4 follow-up), not a
  // fixture. Fixed by sorting the keys into a fresh object (insertion order is
  // preserved by JS for string keys) and passing `null` as the replacer.
  const sortedByKey = <T>(obj: Record<string, T>): Record<string, T> => {
    const sorted: Record<string, T> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
    return sorted;
  };

  const sourceMap: Record<string, string[]> = {};
  for (const node of input.nodes) {
    if (node.evidence.length === 0) continue;
    sourceMap[node.id] = node.evidence.map((e) => (e.symbol ? `${e.path}::${e.symbol}` : e.path));
  }
  writeFile(input.outDir, "traceability/source-map.json", JSON.stringify(sortedByKey(sourceMap), null, 2), written);

  const knowledgeMap: Record<string, Array<{ target: string; relationship_type: string }>> = {};
  for (const edge of input.edges) {
    if (!knowledgeMap[edge.source_node]) knowledgeMap[edge.source_node] = [];
    knowledgeMap[edge.source_node].push({ target: edge.target_node, relationship_type: edge.relationship_type });
  }
  writeFile(input.outDir, "traceability/knowledge-map.json", JSON.stringify(sortedByKey(knowledgeMap), null, 2), written);

  // --- reconstruction level -------------------------------------------------
  const nodesByType = groupByType(input.nodes);
  // `hasReconstructionArtifacts` stays false here, correctly — `.reconstruction/`
  // is `pkr reconstruct`'s output, generated in a later, separate step this
  // render call has no way to know about yet, so level 4/5 aren't achievable
  // from `pkr export`/`pkr update` alone today. That's a real, known
  // limitation (not this fix's scope — a future `pkr reconstruct` writing an
  // achieved level back into this manifest is the honest way to close it,
  // ARCHITECTURE.md §18/§20), separate from `hasValidationCriteria`, which
  // levels.ts now needs as a genuinely distinct signal from
  // `hasReconstructionArtifacts` (§18) — wired to a real signal already
  // available here (stage 2's extracted build/test commands) rather than
  // left hardcoded, so the two flags can never silently collapse back into
  // one again.
  const achievedLevel = computeAchievableLevel({
    nodesByType,
    hasReconstructionArtifacts: false,
    hasValidationCriteria: Object.keys(input.validationCommands ?? {}).length > 0,
  });

  // --- manifest --------------------------------------------------------------
  const nodesSorted = [...input.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const nodesHash = createHash("sha256").update(nodesSorted.map((n) => n.id).join("\n")).digest("hex");

  const manifest: Manifest = {
    schema_version: "0.1",
    project: {
      name: input.projectName,
      ...(input.projectDescription ? { description: input.projectDescription } : {}),
    },
    knowledge: {
      generated_at: generatedAt,
      source_commit: input.sourceCommit,
      generator_version: input.generatorVersion,
      knowledge_version: input.knowledgeVersion,
    },
    reconstruction: { target_level: achievedLevel },
    sections: sectionsPresent,
    ...(input.validationCommands ? { validation: { commands: input.validationCommands } } : {}),
    integrity: {
      node_count: input.nodes.length,
      edge_count: input.edges.length,
      nodes_hash: `sha256:${nodesHash}`,
    },
  };
  writeFile(input.outDir, "manifest.yaml", yaml.dump(manifest, { sortKeys: true }), written);

  // --- README ------------------------------------------------------------
  const readme = [
    `# ${input.projectName} — Project Knowledge Repository`,
    "",
    "This directory is generated by `pkr export`. It is a structured, versioned",
    "representation of this project's intent, architecture, and implementation",
    "constraints — separate from the source code itself. See `manifest.yaml` for",
    "the machine-readable entry point.",
    "",
    `Achieved reconstruction level: **${achievedLevel}** (see PKR_SPEC.md §3 for what each level means).`,
    "",
    "Generated by an automated extractor. Facts are labeled `observed`, `inferred`,",
    "`confirmed`, or `unknown` — see any section file for the evidence backing a claim.",
    "",
  ].join("\n");
  writeFile(input.outDir, "README.md", readme, written);

  return { writtenFiles: written, totalRedactions, achievedLevel };
}
