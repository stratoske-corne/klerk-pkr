/**
 * Renders the Reconstruction Package — ARCHITECTURE.md §4 step 4/5.
 *
 * NOT the same thing as PKR_SPEC.md §1's `.projectknowledge/reconstruction/`
 * directory (reconstruction.md / deterministic-constraints.md / etc. —
 * that's a section of the *export* output, stage 7, not built yet). This is
 * the separate `.reconstruction/` deliverable that `pkr reconstruct`
 * produces: a small, agent-optimized bundle designed to be handed to a
 * fresh AI coding agent with no access to the original source.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { KnowledgeNode, Manifest, NodeType } from "../types.js";
import type { BuildPhase } from "./buildOrder.js";

const IMPLEMENTATION_CONSTRAINT_TYPES: NodeType[] = [
  "tech-choice",
  "convention",
  "dependency",
  "api-endpoint",
  "db-table",
  "event",
  "external-service",
];

const CONTEXT_TYPES: NodeType[] = [
  "requirement",
  "user-flow",
  "domain-concept",
  "business-rule",
  "invariant",
  "edge-case",
  "error-behavior",
  "decision",
];

const RECONSTRUCTION_LEVEL_DESCRIPTIONS: Record<number, string> = {
  0: "no reconstruction claim — this PKR has no product/behavior layer yet; treat it as structural reference only.",
  1: "the general product idea and purpose (concept-level).",
  2: "equivalent user-visible behavior, not necessarily the same architecture.",
  3: "the same major architecture, components, and data model, not necessarily the same technology.",
  4: "the same languages, frameworks, major libraries, APIs, database schema, directory conventions, and component boundaries.",
  5: "a structurally very similar implementation — not byte-for-byte, but a near-deterministic semantic reconstruction.",
};

function renderNode(node: KnowledgeNode): string {
  const parts = [`### ${node.title} \`${node.id}\``, "", `Status: ${node.status}`];
  if (node.status === "inferred" && node.confidence !== null) parts.push(`Confidence: ${node.confidence.toFixed(2)}`);
  parts.push("", node.content.trim());
  if (node.evidence.length > 0) {
    parts.push("", "Evidence:", ...node.evidence.map((e) => `- ${e.path}${e.lines ? `:${e.lines[0]}-${e.lines[1]}` : ""}`));
  }
  return parts.join("\n").trimEnd() + "\n";
}

function groupByType(nodes: KnowledgeNode[], types: NodeType[]): Map<NodeType, KnowledgeNode[]> {
  const map = new Map<NodeType, KnowledgeNode[]>();
  for (const type of types) {
    const matched = nodes.filter((n) => n.type === type).sort((a, b) => a.id.localeCompare(b.id));
    if (matched.length > 0) map.set(type, matched);
  }
  return map;
}

function writeFile(outDir: string, name: string, content: string, written: string[]): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), content.endsWith("\n") ? content : content + "\n", "utf8");
  written.push(name);
}

export interface ReconstructRenderInput {
  outDir: string;
  manifest: Manifest;
  nodes: KnowledgeNode[];
  buildOrder: BuildPhase[];
  loadSource: "jsonl" | "markdown-fallback";
}

export interface ReconstructRenderResult {
  writtenFiles: string[];
}

export function renderReconstructionPackage(input: ReconstructRenderInput): ReconstructRenderResult {
  const { outDir, manifest, nodes, buildOrder } = input;
  const written: string[] = [];
  const level = manifest.reconstruction.target_level;

  // --- SYSTEM_PROMPT.md ---------------------------------------------------
  const requirementTitles = nodes
    .filter((n) => n.type === "requirement")
    .slice(0, 8)
    .map((n) => `- ${n.title} (\`${n.id}\`)`);

  const systemPrompt = [
    `# System Prompt — Rebuilding ${manifest.project.name}`,
    "",
    "You are an AI coding agent reconstructing a software project from its Project",
    "Knowledge Repository (PKR) alone. You do NOT have access to the original source",
    "code — only this package.",
    "",
    manifest.project.description ? `> ${manifest.project.description}` : "",
    "",
    "## How to use this package",
    "",
    "- `BUILD_ORDER.md` — implementation order, phase by phase.",
    "- `CONSTRAINTS.md` — implementation constraints extracted from the original (tech stack, schema, APIs, conventions). Follow these, don't improvise around them.",
    "- `ACCEPTANCE_TESTS.md` — machine-checkable criteria your reconstruction should satisfy.",
    "- `CONTEXT.md` — everything else: requirements, user flows, domain concepts, business rules, prior decisions.",
    "- `KNOWN_AMBIGUITIES.md` — gaps this PKR could not resolve. Treat these as decisions **you** must make and document as you go — not as blockers. Do not stop to ask; state your assumption and continue.",
    "",
    "## The three-layer model (PRODUCT_SPEC.md §3)",
    "",
    "Every fact here is one of:",
    "- **Intent** — what should exist and why (requirements, user flows, domain concepts)",
    "- **Implementation constraint** — how it must be built (tech stack, schema, API shapes, conventions)",
    "- **Behavior** — rules the system must enforce (business rules, invariants, edge cases, error handling)",
    "",
    "Every fact also carries a status: `observed` (read directly from the original source —",
    "treat as ground truth), `inferred` (LLM-synthesized, with a confidence score — treat as a",
    "strong hint, not a certainty, weighted by that score), or `confirmed` (a human reviewed and",
    "affirmed it — treat as ground truth).",
    "",
    "## Reconstruction target",
    "",
    `This PKR's manifest claims reconstruction level **${level}** (PKR_SPEC.md §3): ${RECONSTRUCTION_LEVEL_DESCRIPTIONS[level] ?? "unspecified."}`,
    "Do not invent detail beyond what CONSTRAINTS.md and CONTEXT.md actually support — an",
    "under-specified area belongs in your own documented assumptions, not fabricated certainty.",
    "",
    requirementTitles.length > 0 ? "## Top requirements" : "",
    requirementTitles.length > 0 ? "" : "",
    ...requirementTitles,
    "",
    `Generated by ${manifest.knowledge.generator_version} from source commit ${manifest.knowledge.source_commit ?? "(unknown)"}.`,
  ]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === "")) // collapse accidental double blank lines
    .join("\n");
  writeFile(outDir, "SYSTEM_PROMPT.md", systemPrompt, written);

  // --- BUILD_ORDER.md -------------------------------------------------------
  const buildOrderLines = ["# Build Order", ""];
  if (buildOrder.every((p) => p.nodes.length === 0)) {
    buildOrderLines.push(
      "No node-backed phases could be populated from this PKR (likely a deterministic-only export — see",
      "manifest.yaml `sections`). Fall back to the canonical order: repository init → runtime config →",
      "database schema → domain models → components → APIs → business behavior → tests.",
    );
  }
  for (const phase of buildOrder) {
    buildOrderLines.push(`## ${phase.name}`, "", phase.description, "");
    if (phase.nodes.length === 0) {
      buildOrderLines.push("(no directly evidenced items for this phase in this PKR)", "");
      continue;
    }
    for (const n of phase.nodes) buildOrderLines.push(`- \`${n.id}\` ${n.title}`);
    buildOrderLines.push("");
  }
  buildOrderLines.push(
    "> Ordering note: this is phase-order, not a computed dependency graph — no extraction stage in this",
    "> generator version produces `depends_on`/`exposes` edges between nodes yet (ARCHITECTURE.md §11).",
    "> Use judgment for ordering *within* a phase.",
  );
  writeFile(outDir, "BUILD_ORDER.md", buildOrderLines.join("\n"), written);

  // --- CONSTRAINTS.md ---------------------------------------------------
  const constraintGroups = groupByType(nodes, IMPLEMENTATION_CONSTRAINT_TYPES);
  const constraintLines = ["# Constraints", "", "Implementation constraints extracted from the original project. Follow these exactly where given."];
  if (constraintGroups.size === 0) {
    constraintLines.push("", "(none extracted — this PKR has no implementation-layer nodes)");
  }
  for (const [type, typeNodes] of constraintGroups) {
    constraintLines.push("", `## ${type}`, "");
    for (const n of typeNodes) constraintLines.push(renderNode(n));
  }
  writeFile(outDir, "CONSTRAINTS.md", constraintLines.join("\n"), written);

  // --- ACCEPTANCE_TESTS.md ---------------------------------------------------
  const acceptanceLines = ["# Acceptance Tests", "", "Machine-checkable criteria your reconstruction should satisfy."];
  const commands = manifest.validation?.commands ?? {};
  if (Object.keys(commands).length > 0) {
    acceptanceLines.push("", "## Commands");
    for (const [key, cmd] of Object.entries(commands)) acceptanceLines.push(`- ${key}: \`${cmd}\``);
  }
  const apiNodes = nodes.filter((n) => n.type === "api-endpoint").sort((a, b) => a.id.localeCompare(b.id));
  if (apiNodes.length > 0) {
    acceptanceLines.push("", "## Expected endpoints", "");
    for (const n of apiNodes) acceptanceLines.push(`- ${n.title}`);
  }
  const dbNodes = nodes.filter((n) => n.type === "db-table").sort((a, b) => a.id.localeCompare(b.id));
  if (dbNodes.length > 0) {
    acceptanceLines.push("", "## Expected database tables", "");
    for (const n of dbNodes) acceptanceLines.push(`- ${n.title}`);
  }
  if (Object.keys(commands).length === 0 && apiNodes.length === 0 && dbNodes.length === 0) {
    acceptanceLines.push("", "(no machine-checkable criteria extracted — this PKR predates stage 3/5, or the project has none of these)");
  }
  writeFile(outDir, "ACCEPTANCE_TESTS.md", acceptanceLines.join("\n"), written);

  // --- CONTEXT.md ---------------------------------------------------
  const contextGroups = groupByType(nodes, CONTEXT_TYPES);
  const contextLines = [
    "# Context",
    "",
    "Product intent, behavior, and prior decisions — everything not already covered by CONSTRAINTS.md",
    "or ACCEPTANCE_TESTS.md.",
    "",
    "> Ordering note: grouped by type then by ID — not ranked by importance (no edge graph to compute",
    "> centrality from yet, ARCHITECTURE.md §4/§11). Read all of it, don't assume earlier = more important.",
  ];
  if (contextGroups.size === 0) {
    contextLines.push("", "(no product/behavior/decision nodes in this PKR — likely a deterministic-only export)");
  }
  for (const [type, typeNodes] of contextGroups) {
    contextLines.push("", `## ${type}`, "");
    for (const n of typeNodes) contextLines.push(renderNode(n));
  }
  writeFile(outDir, "CONTEXT.md", contextLines.join("\n"), written);

  // --- KNOWN_AMBIGUITIES.md ---------------------------------------------------
  const ambiguous = nodes.filter((n) => n.status === "unknown" || n.status === "historical-lost");
  const ambiguityLines = ["# Known Ambiguities", ""];
  if (ambiguous.length === 0) {
    ambiguityLines.push(
      "No nodes in this PKR are flagged `unknown` or `historical-lost`. This does not mean the PKR is",
      "complete — it means the extractor found no evidence gap worth flagging explicitly at the current",
      "extraction depth. Treat anything CONTEXT.md/CONSTRAINTS.md is silent on as genuinely unspecified,",
      "not as confirmed non-existence.",
    );
  } else {
    ambiguityLines.push("These items could not be resolved during extraction. Make a documented decision for each rather than blocking.", "");
    for (const n of ambiguous) ambiguityLines.push(renderNode(n));
  }
  writeFile(outDir, "KNOWN_AMBIGUITIES.md", ambiguityLines.join("\n"), written);

  return { writtenFiles: written };
}
