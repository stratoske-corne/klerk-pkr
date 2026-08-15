/**
 * Loads a `.projectknowledge/` directory back into a node/edge graph.
 *
 * Two paths, in priority order:
 *  1. `.knowledge/nodes.jsonl` + `edges.jsonl` — the literal internal store
 *     (PKR_SPEC.md §8), when it travelled with the PKR.
 *  2. A best-effort markdown-fallback parser that reconstructs nodes from
 *     the rendered `*.md` files alone. This is what makes the format
 *     genuinely portable (PKR_SPEC.md §0/§8: "the format must survive
 *     losing the internal store") — a PKR someone committed to git with
 *     `.knowledge/` gitignored, or handed to you as a plain folder of
 *     Markdown, still reconstructs. It parses *our own* render format
 *     exactly (render.ts); it is not a general Markdown/CommonMark parser,
 *     and does not currently recover per-symbol evidence (`path::symbol`)
 *     since no extraction stage produces that yet either.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import { Manifest, KnowledgeNode, KnowledgeEdge, type EvidenceRef, type NodeType } from "../types.js";
import { NODE_TYPE_TARGET } from "../render/render.js";

export interface LoadedPkr {
  manifest: Manifest;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  source: "jsonl" | "markdown-fallback";
}

export function loadManifest(pkrDir: string): Manifest {
  const manifestPath = path.join(pkrDir, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Not a Project Knowledge Repository: no manifest.yaml in ${pkrDir}. ` +
        `Run \`pkr export\` first, or point at the .projectknowledge/ directory it produced.`,
    );
  }
  const raw = yaml.load(fs.readFileSync(manifestPath, "utf8"));
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`manifest.yaml did not match the expected schema: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function loadPkr(pkrDir: string): LoadedPkr {
  const manifest = loadManifest(pkrDir);

  const fromJsonl = loadFromJsonl(pkrDir);
  if (fromJsonl) {
    return { manifest, nodes: fromJsonl.nodes, edges: fromJsonl.edges, source: "jsonl" };
  }

  const nodes = loadNodesFromMarkdown(pkrDir);
  return { manifest, nodes, edges: [], source: "markdown-fallback" };
}

// ---------------------------------------------------------------------------
// Path 1 — internal store
// ---------------------------------------------------------------------------

function readJsonl(filePath: string): unknown[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function loadFromJsonl(pkrDir: string): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } | null {
  const nodesPath = path.join(pkrDir, ".knowledge", "nodes.jsonl");
  if (!fs.existsSync(nodesPath)) return null;

  const nodes = readJsonl(nodesPath).map((raw) => KnowledgeNode.parse(raw));
  const edgesPath = path.join(pkrDir, ".knowledge", "edges.jsonl");
  const edges = fs.existsSync(edgesPath) ? readJsonl(edgesPath).map((raw) => KnowledgeEdge.parse(raw)) : [];
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Path 2 — markdown fallback
// ---------------------------------------------------------------------------

/** Inverts render.ts's NODE_TYPE_TARGET (a bijection) so a section file's relative path maps back to its node type. */
function buildFileToTypeMap(): Map<string, NodeType> {
  const map = new Map<string, NodeType>();
  for (const [type, target] of Object.entries(NODE_TYPE_TARGET) as Array<[NodeType, { dir: string; file: string } | undefined]>) {
    if (!target) continue;
    map.set(`${target.dir}/${target.file}`, type);
  }
  return map;
}

function stripFrontMatter(content: string): { body: string; nodeIds: string[] } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match) return { body: content, nodeIds: [] };
  const idsMatch = /node_ids:\s*\[(.*?)\]/.exec(match[1]);
  const nodeIds = idsMatch ? idsMatch[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  return { body: content.slice(match[0].length), nodeIds };
}

function parseEvidenceLine(raw: string): EvidenceRef {
  const m = /^(.+?)(?::(\d+)-(\d+))?$/.exec(raw.trim());
  if (!m) return { path: raw.trim() };
  const [, p, l1, l2] = m;
  const ref: EvidenceRef = { path: p };
  if (l1 && l2) ref.lines = [parseInt(l1, 10), parseInt(l2, 10)];
  return ref;
}

/** Parses everything after a node's header line: Status/Confidence/Confirmed-by lines, free-text content, then an optional Evidence bullet list. */
function parseNodeBody(rest: string): {
  status: KnowledgeNode["status"];
  confidence: number | null;
  confirmedBy: "human" | null;
  content: string;
  evidence: EvidenceRef[];
} {
  const statusMatch = /^Status:\s*(\S+)/m.exec(rest);
  const confMatch = /^Confidence:\s*([\d.]+)/m.exec(rest);
  const confirmedMatch = /^Confirmed by:\s*human/m.exec(rest);

  const evidenceHeaderIdx = rest.search(/^Evidence:\s*$/m);
  const beforeEvidence = evidenceHeaderIdx >= 0 ? rest.slice(0, evidenceHeaderIdx) : rest;
  const content = beforeEvidence
    .replace(/^Status:.*$/m, "")
    .replace(/^Confidence:.*$/m, "")
    .replace(/^Confirmed by:.*$/m, "")
    .trim();

  const evidence: EvidenceRef[] = [];
  if (evidenceHeaderIdx >= 0) {
    const evBlock = rest.slice(rest.indexOf("\n", evidenceHeaderIdx) + 1);
    for (const line of evBlock.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const bullet = /^-\s+(.+)$/.exec(trimmed);
      if (!bullet) break; // first non-bullet, non-blank line ends the evidence list
      evidence.push(parseEvidenceLine(bullet[1]));
    }
  }

  return {
    status: (statusMatch?.[1] as KnowledgeNode["status"]) ?? "unknown",
    confidence: confMatch ? parseFloat(confMatch[1]) : null,
    confirmedBy: confirmedMatch ? "human" : null,
    content,
    evidence,
  };
}

function parseSectionFile(content: string, type: NodeType): KnowledgeNode[] {
  const { body } = stripFrontMatter(content);
  const nodes: KnowledgeNode[] = [];
  const sections = body.split(/\n(?=### )/);

  for (const section of sections) {
    const firstLine = section.split("\n")[0];
    if (!firstLine.startsWith("### ")) continue;
    const headerMatch = /^###\s+(.*?)\s+`([^`]+)`\s*$/.exec(firstLine);
    if (!headerMatch) continue;
    const [, title, id] = headerMatch;

    const rest = section.split("\n").slice(1).join("\n");
    const parsed = parseNodeBody(rest);
    const now = new Date().toISOString();

    const candidate = KnowledgeNode.safeParse({
      id,
      project_id: "reconstructed",
      type,
      title,
      content: parsed.content || title,
      status: parsed.status,
      confidence: parsed.status === "inferred" ? (parsed.confidence ?? 0.5) : null,
      confirmed_by: parsed.confirmedBy,
      evidence: parsed.evidence,
      supersedes: null,
      created_at: now,
      updated_at: now,
    });
    if (candidate.success) nodes.push(candidate.data);
  }
  return nodes;
}

function parseDecisionFile(content: string): KnowledgeNode | null {
  const { body, nodeIds } = stripFrontMatter(content);
  const titleMatch = /^#\s+(.+)$/m.exec(body);
  if (!titleMatch || nodeIds.length === 0) return null;

  const rest = body.slice(body.indexOf("\n", body.indexOf(titleMatch[0])) + 1);
  const parsed = parseNodeBody(rest);
  const now = new Date().toISOString();

  const candidate = KnowledgeNode.safeParse({
    id: nodeIds[0],
    project_id: "reconstructed",
    type: "decision",
    title: titleMatch[1],
    content: parsed.content || titleMatch[1],
    status: parsed.status,
    confidence: parsed.status === "inferred" ? (parsed.confidence ?? 0.5) : null,
    confirmed_by: parsed.confirmedBy,
    evidence: parsed.evidence,
    supersedes: null,
    created_at: now,
    updated_at: now,
  });
  return candidate.success ? candidate.data : null;
}

function loadNodesFromMarkdown(pkrDir: string): KnowledgeNode[] {
  const fileToType = buildFileToTypeMap();
  const nodes: KnowledgeNode[] = [];

  for (const [relPath, type] of fileToType.entries()) {
    const abs = path.join(pkrDir, relPath);
    if (!fs.existsSync(abs)) continue;
    nodes.push(...parseSectionFile(fs.readFileSync(abs, "utf8"), type));
  }

  const decisionsDir = path.join(pkrDir, "decisions");
  if (fs.existsSync(decisionsDir)) {
    for (const entry of fs.readdirSync(decisionsDir)) {
      if (!entry.endsWith(".md")) continue;
      const node = parseDecisionFile(fs.readFileSync(path.join(decisionsDir, entry), "utf8"));
      if (node) nodes.push(node);
    }
  }

  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}
