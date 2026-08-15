/**
 * Stage 3 — Interface analysis. ARCHITECTURE.md §2 stage 3.
 *
 * Heuristic/regex-based detection (ARCHITECTURE.md §11: "heuristic-first,
 * upgrade per language as gap analysis demands it" — no AST parser yet).
 * Everything here is read directly off source/config file content, so every
 * node is `status: observed`, never `inferred` — a regex match is a fact
 * about what the file contains, not a judgment call.
 *
 * Covers, in this slice: HTTP routes (Express/Fastify/Koa-style handler
 * calls + Next.js file-based routing), database tables (Prisma schema +
 * raw SQL CREATE TABLE), and external services (via known-package lookup
 * against already-extracted dependencies). Event-bus detection is a known
 * gap, not built yet — see ARCHITECTURE.md §11.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { IdAllocator } from "../ids.js";
import { makeNode } from "../node-factory.js";
import type { KnowledgeNode } from "../types.js";
import type { Inventory } from "./inventory.js";

const MAX_FILE_BYTES = 512 * 1024; // skip pathologically large files

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

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

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

const ROUTE_CALL_RE = /\b(?:app|router)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
const NEXT_APP_ROUTE_METHOD_RE = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/g;

interface ApiHit {
  method: string;
  routePath: string;
  file: string;
  line: number;
}

function detectExpressStyleRoutes(root: string, files: string[]): ApiHit[] {
  const hits: ApiHit[] = [];
  for (const rel of files) {
    const content = readSafe(root, rel);
    if (!content) continue;
    ROUTE_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROUTE_CALL_RE.exec(content)) !== null) {
      hits.push({ method: m[1].toUpperCase(), routePath: m[3], file: rel, line: lineAt(content, m.index) });
    }
  }
  return hits;
}

/** Next.js file-based routing: pages/api/**, app/**\/route.ts — the route path comes from the file path itself. */
function detectNextFileRoutes(root: string, files: string[]): ApiHit[] {
  const hits: ApiHit[] = [];
  for (const rel of files) {
    const isPagesApi = /(^|\/)pages\/api\//.test(rel);
    const isAppRoute = /(^|\/)app\/.*\/route\.(ts|js|tsx|jsx)$/.test(rel);
    if (!isPagesApi && !isAppRoute) continue;

    if (isPagesApi) {
      const routePath = "/" + rel.replace(/^.*pages\/api\//, "api/").replace(/\.(ts|js|tsx|jsx)$/, "").replace(/\/index$/, "");
      hits.push({ method: "ANY", routePath, file: rel, line: 1 });
      continue;
    }

    const routePath = "/" + rel.replace(/^.*?app\//, "").replace(/\/route\.(ts|js|tsx|jsx)$/, "");
    const content = readSafe(root, rel);
    if (!content) continue;
    NEXT_APP_ROUTE_METHOD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let matched = false;
    while ((m = NEXT_APP_ROUTE_METHOD_RE.exec(content)) !== null) {
      matched = true;
      hits.push({ method: m[1], routePath, file: rel, line: lineAt(content, m.index) });
    }
    if (!matched) hits.push({ method: "ANY", routePath, file: rel, line: 1 });
  }
  return hits;
}

export function analyzeApiEndpoints(
  root: string,
  inventory: Inventory,
  allocator: IdAllocator,
  projectId: string,
): KnowledgeNode[] {
  const sourceFiles = inventory.files.filter((f) => f.kind === "source").map((f) => f.path);
  const hits = [...detectExpressStyleRoutes(root, sourceFiles), ...detectNextFileRoutes(root, sourceFiles)];
  if (hits.length === 0) return [];

  // De-dupe identical (method, path) pairs; keep first evidence location.
  const byKey = new Map<string, ApiHit>();
  for (const hit of hits) {
    const key = `${hit.method} ${hit.routePath}`;
    if (!byKey.has(key)) byKey.set(key, hit);
  }

  const nodes: KnowledgeNode[] = [];
  for (const [key, hit] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    nodes.push(
      makeNode(allocator, projectId, "HTTP", {
        type: "api-endpoint",
        title: key,
        content:
          hit.method === "ANY"
            ? `File-based route at \`${hit.file}\`, path \`${hit.routePath}\`. HTTP method(s) handled are determined by the file's exports; individual methods aren't captured in this pass.`
            : `HTTP ${hit.method} handler registered for path \`${hit.routePath}\`.`,
        status: "observed",
        confidence: null,
        evidence: [{ path: hit.file, lines: [hit.line, hit.line] }],
      }),
    );
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Database schema
// ---------------------------------------------------------------------------

const PRISMA_MODEL_RE = /model\s+(\w+)\s*\{([^}]*)\}/g;
const PRISMA_FIELD_RE = /^(\w+)\s+(\S+)/;

function analyzePrismaSchema(root: string, relPath: string, allocator: IdAllocator, projectId: string): KnowledgeNode[] {
  const content = readSafe(root, relPath);
  if (!content) return [];
  const nodes: KnowledgeNode[] = [];
  PRISMA_MODEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PRISMA_MODEL_RE.exec(content)) !== null) {
    const modelName = m[1];
    const fields = m[2]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
      .map((l) => PRISMA_FIELD_RE.exec(l))
      .filter((fm): fm is RegExpExecArray => fm !== null)
      .map((fm) => `${fm[1]}: ${fm[2]}`);

    nodes.push(
      makeNode(allocator, projectId, "SCHEMA", {
        type: "db-table",
        title: modelName,
        content: `Prisma model \`${modelName}\`` + (fields.length ? ` with fields:\n\n${fields.map((f) => `- ${f}`).join("\n")}` : "."),
        status: "observed",
        confidence: null,
        evidence: [{ path: relPath, lines: [lineAt(content, m.index), lineAt(content, m.index + m[0].length)] }],
      }),
    );
  }
  return nodes;
}

const SQL_CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s*\(([\s\S]*?)\)\s*;/gi;
const SQL_COLUMN_LINE_RE = /^["'`]?(\w+)["'`]?\s+([A-Za-z][\w()]*)/;
const SQL_NON_COLUMN_RE = /^(primary|foreign|constraint|unique|check|key)\b/i;

function analyzeSqlFile(root: string, relPath: string, allocator: IdAllocator, projectId: string): KnowledgeNode[] {
  const content = readSafe(root, relPath);
  if (!content) return [];
  const nodes: KnowledgeNode[] = [];
  SQL_CREATE_TABLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SQL_CREATE_TABLE_RE.exec(content)) !== null) {
    const tableName = m[1];
    const columns = m[2]
      .split(",")
      .map((l) => l.trim())
      .filter((l) => l && !SQL_NON_COLUMN_RE.test(l))
      .map((l) => SQL_COLUMN_LINE_RE.exec(l))
      .filter((cm): cm is RegExpExecArray => cm !== null)
      .map((cm) => `${cm[1]}: ${cm[2]}`);

    nodes.push(
      makeNode(allocator, projectId, "SCHEMA", {
        type: "db-table",
        title: tableName,
        content: `SQL table \`${tableName}\`` + (columns.length ? ` with columns:\n\n${columns.map((c) => `- ${c}`).join("\n")}` : "."),
        status: "observed",
        confidence: null,
        evidence: [{ path: relPath, lines: [lineAt(content, m.index), lineAt(content, m.index + m[0].length)] }],
      }),
    );
  }
  return nodes;
}

export function analyzeDatabaseSchema(
  root: string,
  inventory: Inventory,
  allocator: IdAllocator,
  projectId: string,
): KnowledgeNode[] {
  const nodes: KnowledgeNode[] = [];
  for (const f of inventory.files) {
    if (f.path.endsWith(".prisma")) nodes.push(...analyzePrismaSchema(root, f.path, allocator, projectId));
    else if (f.path.endsWith(".sql")) nodes.push(...analyzeSqlFile(root, f.path, allocator, projectId));
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// External services — derived from dependency names stage 2 already extracted
// ---------------------------------------------------------------------------

const KNOWN_EXTERNAL_SERVICES: Record<string, string> = {
  stripe: "Stripe",
  "aws-sdk": "AWS SDK",
  "@aws-sdk/client-s3": "AWS S3",
  twilio: "Twilio",
  "@sendgrid/mail": "SendGrid",
  openai: "OpenAI API",
  "@anthropic-ai/sdk": "Anthropic API",
  googleapis: "Google APIs",
  "firebase-admin": "Firebase Admin",
  mongodb: "MongoDB",
  mongoose: "MongoDB (via Mongoose)",
  pg: "PostgreSQL",
  mysql2: "MySQL",
  redis: "Redis",
  ioredis: "Redis",
  nodemailer: "SMTP (via Nodemailer)",
  "@slack/web-api": "Slack API",
  algoliasearch: "Algolia",
  "@sentry/node": "Sentry",
};

export function analyzeExternalServices(
  dependencyPackageNames: string[],
  allocator: IdAllocator,
  projectId: string,
): KnowledgeNode[] {
  const nodes: KnowledgeNode[] = [];
  const seen = new Set<string>();
  for (const name of dependencyPackageNames) {
    const friendly = KNOWN_EXTERNAL_SERVICES[name];
    if (!friendly || seen.has(friendly)) continue;
    seen.add(friendly);
    nodes.push(
      makeNode(allocator, projectId, "SERVICE", {
        type: "external-service",
        title: friendly,
        content: `The project integrates with ${friendly}, via the \`${name}\` package declared in package.json.`,
        status: "observed",
        confidence: null,
        evidence: [{ path: "package.json" }],
      }),
    );
  }
  return nodes;
}
