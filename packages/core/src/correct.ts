/**
 * `pkr confirm` / `pkr edit` — human correction (PRODUCT_SPEC.md §5.5,
 * PKR_SPEC.md §4.2/§8). Until now the confirmed-node-protection mechanism
 * this session validated exhaustively (§16 Run 4, §19, the mergeNodes
 * confirmed-node-leak regression) had zero user-facing way to actually
 * *create* a confirmed node — every test that needed one built it by
 * writing to the store directly. This is that missing surface.
 *
 * `pkr confirm <id>` marks a node confirmed as-is. `pkr edit <id> --title
 * ... --content ...` does the same but also overwrites title/content —
 * editing a node's content *is* correcting it, so it becomes confirmed too;
 * PRODUCT_SPEC.md §5.5 lists "confirm or correct" as one feature, not two,
 * and there's no useful "edited but still just observed/inferred" state to
 * distinguish. Both share this one function; `pkr edit` is `pkr confirm`
 * with `title`/`content` set.
 *
 * PKR_SPEC.md §4.1's structural rule (a confirmed node carries no
 * confidence) is enforced the same way as everywhere else in this codebase
 * — `KnowledgeNode.parse()` at save time, not by convention here.
 *
 * Also commits a Knowledge Version (ARCHITECTURE.md §24) with `author:
 * "human"` — the first time anything in this codebase attributes a
 * version to a human rather than the extractor, and a new `"confirmed"`
 * ChangeKind so this doesn't get confused with an ordinary automated
 * re-extraction `"modified"` in `pkr log`/`pkr diff`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { FileNodeStore } from "./store/fileNodeStore.js";
import { loadManifest } from "./reconstruct/loadPkr.js";
import { renderProjectKnowledge } from "./render/render.js";
import { commitVersion } from "./versions.js";
import type { KnowledgeNode } from "./types.js";

export interface CorrectNodeOptions {
  /** Path to a .projectknowledge/ directory. */
  outDir: string;
  nodeId: string;
  /** If given, overwrites the node's title (`pkr edit`). Omit for a plain `pkr confirm`. */
  title?: string;
  /** If given, overwrites the node's content (`pkr edit`). Omit for a plain `pkr confirm`. */
  content?: string;
}

export interface CorrectNodeResult {
  node: KnowledgeNode;
  wasAlreadyConfirmed: boolean;
  knowledgeVersion: string;
  writtenFiles: string[];
}

export function confirmOrEditNode(options: CorrectNodeOptions): CorrectNodeResult {
  const outDir = path.resolve(options.outDir);
  const knowledgeDir = path.join(outDir, ".knowledge");

  const manifest = loadManifest(outDir); // throws a clean "Not a Project Knowledge Repository" error if missing

  if (!fs.existsSync(path.join(knowledgeDir, "nodes.jsonl"))) {
    throw new Error(
      `"${outDir}" has no internal .knowledge/ store to write corrections to (a markdown-only, portability-fallback copy of a PKR — PKR_SPEC.md §8). ` +
        `pkr confirm/edit need the store that produced it — run this against the original export's directory.`,
    );
  }

  const store = FileNodeStore.load(knowledgeDir);
  const existing = store.getNode(options.nodeId);
  if (!existing) {
    throw new Error(`No node "${options.nodeId}" in this PKR. Check the ID against the rendered files or \`.knowledge/nodes.jsonl\`.`);
  }

  const wasAlreadyConfirmed = existing.status === "confirmed";
  const updated: KnowledgeNode = {
    ...existing,
    title: options.title ?? existing.title,
    content: options.content ?? existing.content,
    status: "confirmed",
    confidence: null,
    confirmed_by: "human",
    updated_at: new Date().toISOString(),
  };

  // Safe regardless of prior state: `existing` was either not confirmed yet
  // (upsertNode's protection check doesn't apply), or already confirmed —
  // `confirmed_by` on a KnowledgeNode is only ever "human" or null, so a
  // node that reached "confirmed" status could only have gotten there via
  // this same function, meaning `updated.confirmed_by: "human"` always
  // satisfies the check on a re-confirm too.
  store.upsertNode(updated);
  store.save();

  const isEdit = options.title !== undefined || options.content !== undefined;
  // Exactly one changed node, always non-empty -> commitVersion can never
  // return null here (its only empty-guard case).
  const knowledgeVersion = commitVersion(knowledgeDir, {
    summary: `${isEdit ? "pkr edit" : "pkr confirm"}: ${updated.id} "${updated.title}"`,
    changedNodes: [{ id: updated.id, change: "confirmed" }],
    sourceCommit: manifest.knowledge.source_commit,
    author: "human",
  })!;

  const renderResult = renderProjectKnowledge({
    outDir,
    projectName: manifest.project.name,
    projectDescription: manifest.project.description,
    nodes: store.listNodes(),
    edges: store.listEdges(),
    sourceCommit: manifest.knowledge.source_commit,
    generatorVersion: manifest.knowledge.generator_version,
    knowledgeVersion,
    validationCommands: manifest.validation?.commands,
  });

  return { node: updated, wasAlreadyConfirmed, knowledgeVersion, writtenFiles: renderResult.writtenFiles };
}
