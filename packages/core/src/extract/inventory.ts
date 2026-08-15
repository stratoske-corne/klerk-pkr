/**
 * Stage 1 — Ingest & inventory. ARCHITECTURE.md §2 stage 1.
 *
 * Deterministic, `status: observed` by construction — this module has no
 * concept of confidence and cannot produce an inferred fact. It walks the
 * repo respecting .gitignore, classifies each file, and hashes its content.
 * The hash set is what `pkr update` will eventually diff against
 * (ARCHITECTURE.md §2, incremental update) — not used yet in this slice.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// The `ignore` package is CJS-only and ships no "types"/"exports" field, which
// trips up TS's NodeNext type resolution for a default import. Load it via
// createRequire and type the bits we actually use ourselves.
const require = createRequire(import.meta.url);
interface Ignore {
  add(patterns: string | readonly string[]): this;
  ignores(pathname: string): boolean;
}
const ignore: (options?: { ignorecase?: boolean }) => Ignore = require("ignore");

export type FileKind =
  | "source"
  | "config"
  | "test"
  | "docs"
  | "infra"
  | "lockfile"
  | "generated"
  | "other";

export interface InventoryFile {
  /** Repo-relative, POSIX-separated path. */
  path: string;
  kind: FileKind;
  sizeBytes: number;
  sha256: string;
}

export interface Inventory {
  root: string;
  files: InventoryFile[];
}

const ALWAYS_IGNORE = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  ".projectknowledge",
];

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".scala",
  ".vue", ".svelte",
]);

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
]);

const INFRA_BASENAME_PATTERN = /^(dockerfile|docker-compose.*\.ya?ml|.*\.tf)$/i;

function classify(relPath: string): FileKind {
  const base = path.basename(relPath).toLowerCase();
  const ext = path.extname(relPath).toLowerCase();
  const segments = relPath.split("/");

  if (LOCKFILE_NAMES.has(path.basename(relPath))) return "lockfile";
  if (segments.includes(".github") || INFRA_BASENAME_PATTERN.test(base) || segments.includes(".circleci") || segments.includes("k8s")) {
    return "infra";
  }
  if (/(^|\/)(__tests__|tests?|spec)(\/|$)/i.test(relPath) || /\.(test|spec)\.[^/]+$/i.test(relPath)) {
    return "test";
  }
  if (ext === ".md" || ext === ".mdx" || segments.includes("docs") || /^readme/i.test(base) || /^changelog/i.test(base)) {
    return "docs";
  }
  if ([".json", ".yaml", ".yml", ".toml", ".ini"].includes(ext) || base.startsWith(".env") || /^\..*rc(\.[a-z]+)?$/.test(base) || base.startsWith("tsconfig")) {
    return "config";
  }
  if (SOURCE_EXTENSIONS.has(ext)) return "source";
  return "other";
}

function loadIgnore(root: string): Ignore {
  const ig = ignore().add(ALWAYS_IGNORE);
  const gitignorePath = path.join(root, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }
  return ig;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function walk(root: string, dir: string, ig: Ignore, out: InventoryFile[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (ig.ignores(rel) || (entry.isDirectory() && ig.ignores(rel + "/"))) continue;

    if (entry.isDirectory()) {
      walk(root, abs, ig, out);
    } else if (entry.isFile()) {
      const content = fs.readFileSync(abs);
      out.push({
        path: rel,
        kind: classify(rel),
        sizeBytes: content.byteLength,
        sha256: sha256(content),
      });
    }
  }
}

export function buildInventory(root: string): Inventory {
  const ig = loadIgnore(root);
  const files: InventoryFile[] = [];
  walk(root, root, ig, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files };
}
