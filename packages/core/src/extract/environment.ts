/**
 * Stage 5 — Test & environment analysis. ARCHITECTURE.md §2 stage 5 / §28.
 *
 * Three things, all rendering into `implementation/environment.md`
 * (PKR_SPEC.md §1 already reserved that filename; nothing populated it
 * until now) via one new node type, `environment-setup` — the mapping in
 * `render.ts` is a strict type→file bijection, so one target file means
 * one type, the same reasoning `convention` already follows for its own
 * grab-bag of distinct observations:
 *
 *  1. Test file inventory — a count, from stage 1's file classification.
 *     No test file content is read here or anywhere in this module.
 *  2. Referenced environment variable NAMES, never values (PKR_SPEC.md
 *     §10). Two sources, both name-only by construction: `process.env.X`
 *     in source (a property *read* — the value never appears in the source
 *     text at all, there is nothing to accidentally over-capture), and
 *     `.env.example`/`.env.sample`/`.env.template`-named files specifically
 *     (never a real `.env`/`.env.local`/`.env.production` — those
 *     conventionally hold real secrets, so this module never opens them at
 *     all, regardless of how carefully a regex might claim to only capture
 *     the key before `=`).
 *  3. CI/deployment config presence — which platform is configured, not
 *     its contents.
 *
 * Test *runner* identification (Jest/Vitest/etc.) is deliberately NOT
 * duplicated here — `extract/dependencies.ts`'s `KNOWN_FRAMEWORKS` lookup
 * already produces a `tech-choice` node for it from stage 2.
 *
 * schema_version stays "0.1" despite this being an additive node-type
 * change PKR_SPEC.md §0 would otherwise say warrants a minor bump: the
 * manifest's `schema_version` is a hard `z.literal("0.1")` equality check
 * (types.ts), not a semver range — bumping it would reject every
 * already-exported PKR on load (`loadManifest`/`loadPkr`, used by every
 * command except `pkr export` itself), a real regression far out of
 * proportion to this feature. Deliberate simplification, not an oversight.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { IdAllocator } from "../ids.js";
import { makeNode } from "../node-factory.js";
import type { KnowledgeNode } from "../types.js";
import type { Inventory } from "./inventory.js";

const MAX_FILE_BYTES = 512 * 1024;

function readSafe(root: string, relPath: string): string | null {
  try {
    const abs = path.join(root, relPath);
    const stat = fs.statSync(abs);
    if (stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

const PROCESS_ENV_RE = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\2\s*\])/g;

/** Scans source files for `process.env.NAME` / `process.env['NAME']` — property reads, never a value. Returns name -> first file it was seen in. */
function scanSourceEnvNames(root: string, files: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const rel of files) {
    const content = readSafe(root, rel);
    if (!content) continue;
    PROCESS_ENV_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PROCESS_ENV_RE.exec(content)) !== null) {
      const name = m[1] ?? m[3];
      if (!found.has(name)) found.set(name, rel);
    }
  }
  return found;
}

const ENV_EXAMPLE_NAME_RE = /^\.?env\.(example|sample|template)$/i;
const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Scans `.env.example`/`.env.sample`/`.env.template` files (only — never a real `.env`) for variable names, discarding whatever follows `=` unread into anything kept. */
function scanEnvExampleFiles(root: string, allFiles: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const exampleFiles = allFiles.filter((f) => ENV_EXAMPLE_NAME_RE.test(path.basename(f)));
  for (const rel of exampleFiles) {
    const content = readSafe(root, rel);
    if (!content) continue;
    for (const line of content.split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = ENV_LINE_RE.exec(line);
      if (m && !found.has(m[1])) found.set(m[1], rel);
    }
  }
  return found;
}

const CI_MARKERS: Array<{ test: (relPath: string) => boolean; label: string }> = [
  { test: (p) => /^\.github\/workflows\/.+\.ya?ml$/.test(p), label: "GitHub Actions" },
  { test: (p) => p === ".gitlab-ci.yml", label: "GitLab CI" },
  { test: (p) => p === ".circleci/config.yml", label: "CircleCI" },
  { test: (p) => p === "Jenkinsfile", label: "Jenkins" },
  { test: (p) => p === "Dockerfile", label: "Docker" },
  { test: (p) => /^docker-compose\.ya?ml$/.test(p), label: "Docker Compose" },
];

export function analyzeEnvironment(root: string, inventory: Inventory, allocator: IdAllocator, projectId: string): KnowledgeNode[] {
  const nodes: KnowledgeNode[] = [];
  const allPaths = inventory.files.map((f) => f.path);
  const sourceFiles = inventory.files.filter((f) => f.kind === "source").map((f) => f.path);

  // --- test file inventory --------------------------------------------------
  const testFiles = inventory.files.filter((f) => f.kind === "test");
  if (testFiles.length > 0) {
    nodes.push(
      makeNode(allocator, projectId, "ENV", {
        type: "environment-setup",
        title: "Test file inventory",
        content: `${testFiles.length} test file(s) found in the repository (count only — file content isn't read at this stage).`,
        status: "observed",
        confidence: null,
        evidence: testFiles.slice(0, 5).map((f) => ({ path: f.path })),
      }),
    );
  }

  // --- referenced env var names (never values) -------------------------------
  const fromExamples = scanEnvExampleFiles(root, allPaths);
  const fromSource = scanSourceEnvNames(root, sourceFiles);
  const merged = new Map([...fromExamples, ...fromSource]); // source wins on a name seen in both; doesn't matter, both are "found somewhere"
  if (merged.size > 0) {
    const names = [...merged.keys()].sort();
    const evidenceFiles = [...new Set(merged.values())].sort().slice(0, 10);
    nodes.push(
      makeNode(allocator, projectId, "ENV", {
        type: "environment-setup",
        title: "Environment variables referenced",
        content:
          `The project reads ${names.length} environment variable(s) by name (values are never read or recorded — PKR_SPEC.md §10):\n\n` +
          names.map((n) => `- \`${n}\``).join("\n"),
        status: "observed",
        confidence: null,
        evidence: evidenceFiles.map((f) => ({ path: f })),
      }),
    );
  }

  // --- CI / deployment config presence ---------------------------------------
  for (const marker of CI_MARKERS) {
    const hit = inventory.files.find((f) => marker.test(f.path));
    if (!hit) continue;
    nodes.push(
      makeNode(allocator, projectId, "ENV", {
        type: "environment-setup",
        title: `CI/deploy: ${marker.label}`,
        content: `The repository includes ${marker.label} configuration (\`${hit.path}\`).`,
        status: "observed",
        confidence: null,
        evidence: [{ path: hit.path }],
      }),
    );
  }

  return nodes;
}
