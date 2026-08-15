/**
 * `pkr context` — PKR_SPEC.md §9 / PRODUCT_SPEC.md §31.
 *
 * This is deliberately NOT `.reconstruction/`'s framing. `pkr reconstruct`
 * asks "could an agent rebuild this from nothing?" — a benchmark for PKR
 * completeness, not something a working developer wants (the code already
 * exists and runs — nobody wants it rebuilt from Markdown).
 *
 * `pkr context` answers a different, sharper question: "I'm opening this
 * codebase — in this AI session, or a *different* one tomorrow — and I don't
 * want to re-explain it from scratch. What does this agent need to know
 * before it starts reading source or making changes?" That's continuation
 * context, not construction instructions. Same underlying facts as
 * `.reconstruction/CONTEXT.md`, different job: point the reader at *why*
 * and *what must not break*, then defer to the real source for *how it's
 * actually implemented right now*.
 *
 * Per-target differentiation (PKR_SPEC.md §9: "token-budget-aware
 * concatenation order, target-specific front-matter conventions") is a
 * stub in this slice — every target renders the same facts, since the core
 * format is vendor-neutral by design and no target-specific adapter has
 * been justified yet. `target` only changes the output filename and a one-
 * line framing note. Extend per target only when a real need shows up.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { KnowledgeNode, Manifest, NodeType } from "../types.js";

export type ContextTarget = "claude" | "codex" | "generic";

const TARGET_FILENAMES: Record<ContextTarget, string> = {
  claude: "CLAUDE_CONTEXT.md",
  codex: "AGENTS_CONTEXT.md",
  generic: "PROJECT_CONTEXT.md",
};

const SECTION_GROUPS: Array<{ heading: string; types: NodeType[] }> = [
  { heading: "What this project is", types: ["requirement", "user-flow", "domain-concept"] },
  { heading: "Architecture", types: ["component", "boundary", "deployment-unit"] },
  { heading: "Technology & conventions — do not casually substitute these", types: ["tech-choice", "convention"] },
  { heading: "Interfaces", types: ["api-endpoint", "db-table", "event", "external-service"] },
  { heading: "Business rules & invariants — breaking these is a regression, not a refactor", types: ["business-rule", "invariant", "edge-case", "error-behavior"] },
  { heading: "Prior decisions", types: ["decision"] },
];

function renderNode(node: KnowledgeNode): string {
  const parts = [`### ${node.title} \`${node.id}\``, "", `Status: ${node.status}`];
  if (node.status === "inferred" && node.confidence !== null) parts.push(`Confidence: ${node.confidence.toFixed(2)}`);
  parts.push("", node.content.trim());
  if (node.evidence.length > 0) {
    parts.push("", "Evidence:", ...node.evidence.map((e) => `- ${e.path}${e.lines ? `:${e.lines[0]}-${e.lines[1]}` : ""}`));
  }
  return parts.join("\n").trimEnd() + "\n";
}

export interface RenderContextInput {
  outDir: string;
  target: ContextTarget;
  manifest: Manifest;
  nodes: KnowledgeNode[];
  /** How long ago this PKR was generated — surfaced prominently, since staleness is the main risk of a continuation package (no `pkr update` yet — ARCHITECTURE.md §0). */
  generatedAt: string;
}

export interface RenderContextResult {
  writtenFiles: string[];
  filePath: string;
}

export function renderContextPackage(input: RenderContextInput): RenderContextResult {
  const { outDir, target, manifest, nodes } = input;
  const filename = TARGET_FILENAMES[target];

  const lines: string[] = [
    `# Continuing work on ${manifest.project.name}`,
    "",
    "This is a **continuation context** package, not a build spec. This project already exists",
    "as working code — do not try to rebuild it from this document. Use this to understand intent,",
    "architecture, and constraints *before* you read or change source, so you don't have to",
    "rediscover them file-by-file. For exact current implementation, read the actual source —",
    "this document explains *why* and *what must not break*, not *how it's coded right now*.",
    "",
    manifest.project.description ? `> ${manifest.project.description}` : "",
    "",
    `Reconstruction level this PKR supports: **${manifest.reconstruction.target_level}** (PKR_SPEC.md §3).`,
    `Generated: ${input.generatedAt} from source commit ${manifest.knowledge.source_commit ?? "(unknown)"}.`,
    "",
    "> ⚠ **Staleness risk:** this snapshot reflects the repository as of the commit above. `pkr update`",
    "> (incremental re-sync) doesn't exist yet (ARCHITECTURE.md §0) — if the codebase has changed since",
    "> generation, re-run `pkr export` before trusting this over the live source for anything load-bearing.",
    "",
  ];

  const byType = new Map<NodeType, KnowledgeNode[]>();
  for (const node of nodes) {
    if (!byType.has(node.type)) byType.set(node.type, []);
    byType.get(node.type)!.push(node);
  }

  for (const group of SECTION_GROUPS) {
    const groupNodes = group.types
      .flatMap((t) => byType.get(t) ?? [])
      .sort((a, b) => a.id.localeCompare(b.id));
    if (groupNodes.length === 0) continue;
    lines.push(`## ${group.heading}`, "");
    for (const n of groupNodes) lines.push(renderNode(n));
  }

  if (nodes.length === 0) {
    lines.push("(this PKR has no extracted knowledge yet — run `pkr export` first)");
  }

  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, filename);
  fs.writeFileSync(filePath, lines.join("\n").trimEnd() + "\n", "utf8");

  return { writtenFiles: [filename], filePath };
}
