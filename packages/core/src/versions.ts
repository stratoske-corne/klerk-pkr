/**
 * Knowledge Versioning — PKR_SPEC.md §7 / ARCHITECTURE.md §24.
 *
 * Auto-commit MVP: every `pkr export` and every `pkr update` that produces
 * at least one real fact-level change writes an immutable version snapshot
 * to `.knowledge/versions/v0.N.yaml`. Deliberately NOT built here: the
 * draft/staging half of PKR_SPEC.md §7 ("`pkr update` proposes a *draft*
 * version that becomes immutable only when committed via `pkr commit`") —
 * that would mean a new draft-vs-committed state machine over the node
 * store itself, sitting in front of `pkr update`'s already-validated
 * direct-apply behavior (§16-§22). This slice versions the result of an
 * update, it doesn't gate applying one. See ARCHITECTURE.md §24 for the
 * full scope decision.
 *
 * `author` is always `extractor:pkr-cli@0.1.0` for the same reason: there's
 * no interactive `pkr confirm`/`pkr edit` yet to attribute a version to a
 * specific human (PKR_SPEC.md §8 already describes those commands but they
 * aren't built — see ARCHITECTURE.md §0).
 *
 * Numbering is derived by reading `.knowledge/versions/` itself (no
 * separate counter file) — versions are an append-only immutable log, the
 * same reasoning that makes `.knowledge/nodes.jsonl` the source of truth
 * rather than a cache of one.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";

export type ChangeKind = "added" | "modified" | "removed" | "superseded" | "conflict";

export interface ChangedNode {
  id: string;
  change: ChangeKind;
}

export interface VersionRecord {
  version: string; // "v0.N"
  parent_version: string | null;
  created_at: string;
  author: string;
  summary: string;
  changed_nodes: ChangedNode[];
  reason?: string;
  source_commit: string | null;
}

const AUTO_AUTHOR = "extractor:pkr-cli@0.1.0";

function versionsDir(knowledgeDir: string): string {
  return path.join(knowledgeDir, "versions");
}

function parseVersionNumber(fileName: string): number | null {
  const m = /^v0\.(\d+)\.yaml$/.exec(fileName);
  return m ? Number(m[1]) : null;
}

/** All committed versions, oldest first. Empty if none have been committed yet. */
export function listVersions(knowledgeDir: string): VersionRecord[] {
  const dir = versionsDir(knowledgeDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => parseVersionNumber(f) !== null);
  files.sort((a, b) => parseVersionNumber(a)! - parseVersionNumber(b)!);
  return files.map((f) => yaml.load(fs.readFileSync(path.join(dir, f), "utf8")) as VersionRecord);
}

function latestVersion(knowledgeDir: string): VersionRecord | null {
  const versions = listVersions(knowledgeDir);
  return versions.length ? versions[versions.length - 1] : null;
}

/**
 * Writes the next immutable version snapshot and returns its version
 * string (ready to embed in the manifest as `knowledgeVersion` —
 * render.ts). Writes nothing and returns null when `changedNodes` is
 * empty — a version with no actual knowledge change isn't a real commit.
 */
export function commitVersion(
  knowledgeDir: string,
  input: { summary: string; changedNodes: ChangedNode[]; sourceCommit: string | null; reason?: string },
): string | null {
  if (input.changedNodes.length === 0) return null;

  const parent = latestVersion(knowledgeDir);
  const nextN = parent ? Number(parent.version.split(".")[1]) + 1 : 1;
  const version = `v0.${nextN}`;

  const record: VersionRecord = {
    version,
    parent_version: parent?.version ?? null,
    created_at: new Date().toISOString(),
    author: AUTO_AUTHOR,
    summary: input.summary,
    changed_nodes: input.changedNodes,
    ...(input.reason ? { reason: input.reason } : {}),
    source_commit: input.sourceCommit,
  };

  fs.mkdirSync(versionsDir(knowledgeDir), { recursive: true });
  fs.writeFileSync(path.join(versionsDir(knowledgeDir), `${version}.yaml`), yaml.dump(record, { sortKeys: false }), "utf8");
  return version;
}

/** Auto-generated one-line summary from a set of changed nodes, e.g. "+3, ~1, 1 superseded". */
export function summarizeChanges(changedNodes: ChangedNode[]): string {
  const counts: Record<ChangeKind, number> = { added: 0, modified: 0, removed: 0, superseded: 0, conflict: 0 };
  for (const c of changedNodes) counts[c.change]++;

  const parts: string[] = [];
  if (counts.added) parts.push(`+${counts.added}`);
  if (counts.modified) parts.push(`~${counts.modified}`);
  if (counts.removed) parts.push(`-${counts.removed}`);
  if (counts.superseded) parts.push(`${counts.superseded} superseded`);
  if (counts.conflict) parts.push(`${counts.conflict} conflict(s) — needs review`);
  return parts.length ? parts.join(", ") : "no changes"; // commitVersion already guards the empty case
}

function bareVersionNumber(version: string): number | null {
  const m = /^v0\.(\d+)$/.exec(version);
  return m ? Number(m[1]) : null;
}

export interface VersionDiffEntry extends ChangedNode {
  /** Which version's commit this change happened in — a range can span more than one. */
  version: string;
}

export interface VersionDiffResult {
  from: string;
  to: string;
  /** Every changed_nodes entry from every version strictly after `from` up to and including `to`, oldest first. Raw, not deduped/net'd — a node touched twice in the range appears twice (ARCHITECTURE.md §24 — no branching/merge logic exists to collapse that honestly yet). */
  entries: VersionDiffEntry[];
}

/**
 * Aggregates the changed_nodes of every version strictly between `from`
 * (exclusive) and `to` (inclusive), walking `parent_version` — a `git log
 * from..to`-style range, not a computed before/after content diff (that
 * would need to compare actual node content, not just this per-commit
 * ledger — a deliberately bigger feature, not built here). `to` defaults to
 * the latest committed version. Only supports a straight ancestor chain —
 * there's no branching in this data model yet (ARCHITECTURE.md §15 rules
 * it out at the product level too).
 */
export function diffVersions(knowledgeDir: string, fromVersion: string, toVersion?: string): VersionDiffResult {
  const versions = listVersions(knowledgeDir);
  if (versions.length === 0) {
    throw new Error("No knowledge versions committed yet — run `pkr export` first.");
  }

  const byVersion = new Map<string, VersionRecord>(versions.map((v) => [v.version, v]));
  const to = toVersion ?? versions[versions.length - 1].version;

  if (!byVersion.has(fromVersion)) throw new Error(`Unknown version "${fromVersion}" — see \`pkr log\` for what's actually committed.`);
  if (!byVersion.has(to)) throw new Error(`Unknown version "${to}" — see \`pkr log\` for what's actually committed.`);

  if (fromVersion === to) return { from: fromVersion, to, entries: [] };

  const chain: VersionRecord[] = [];
  let cursor: string | null = to;
  while (cursor !== null && cursor !== fromVersion) {
    const record: VersionRecord = byVersion.get(cursor)!; // present — every parent_version is itself a committed version
    chain.push(record);
    cursor = record.parent_version;
  }

  if (cursor !== fromVersion) {
    const fromN = bareVersionNumber(fromVersion);
    const toN = bareVersionNumber(to);
    const reversedHint = fromN !== null && toN !== null && fromN > toN ? ` (did you mean \`pkr diff ${to} ${fromVersion}\`?)` : "";
    throw new Error(`"${fromVersion}" is not an ancestor of "${to}" — pkr diff only supports a straight version range${reversedHint}.`);
  }

  chain.reverse(); // oldest -> newest
  const entries: VersionDiffEntry[] = [];
  for (const record of chain) {
    for (const c of record.changed_nodes) entries.push({ ...c, version: record.version });
  }
  return { from: fromVersion, to, entries };
}
