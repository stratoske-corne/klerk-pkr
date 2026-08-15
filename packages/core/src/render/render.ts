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

  // --- group nodes by target file, skip decisions (rendered per-node) ----
  const byFile = new Map<string, { target: FileTarget; nodes: KnowledgeNode[] }>();
  const decisionNodes = input.nodes.filter((n) => n.type === "decision");
  for (const node of input.nodes) {
    if (node.type === "decision") continue;
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

  // --- traceability --------------------------------------------------------
  const sourceMap: Record<string, string[]> = {};
  for (const node of input.nodes) {
    if (node.evidence.length === 0) continue;
    sourceMap[node.id] = node.evidence.map((e) => (e.symbol ? `${e.path}::${e.symbol}` : e.path));
  }
  writeFile(
    input.outDir,
    "traceability/source-map.json",
    JSON.stringify(sourceMap, Object.keys(sourceMap).sort(), 2),
    written,
  );

  const knowledgeMap: Record<string, Array<{ target: string; relationship_type: string }>> = {};
  for (const edge of input.edges) {
    if (!knowledgeMap[edge.source_node]) knowledgeMap[edge.source_node] = [];
    knowledgeMap[edge.source_node].push({ target: edge.target_node, relationship_type: edge.relationship_type });
  }
  writeFile(
    input.outDir,
    "traceability/knowledge-map.json",
    JSON.stringify(knowledgeMap, Object.keys(knowledgeMap).sort(), 2),
    written,
  );

  // --- reconstruction level -------------------------------------------------
  const nodesByType = groupByType(input.nodes);
  const achievedLevel = computeAchievableLevel({ nodesByType, hasReconstructionArtifacts: false });

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
