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
 * calls, `router.route(x).get(...).post(...)` chains, + Next.js file-based
 * routing), database tables (Prisma schema, raw SQL CREATE TABLE, and
 * Mongoose `Schema`/`model()` pairs), and external services (via
 * known-package lookup against already-extracted dependencies). Event-bus
 * detection is a known gap, not built yet — see ARCHITECTURE.md §11.
 *
 * The chained-route and Mongoose detectors below were added in response to
 * two real gaps found during the M3 blind-reconstruction experiment
 * (ARCHITECTURE.md §16) — not hypothetical cases, an actual repo's routes and
 * schema went undetected. See §16/§18 for what motivated each.
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
// Shared bracket-balancing helpers — used by the route-chain walker (parens)
// and the Mongoose schema-object parser (braces). Not a real tokenizer, but
// string/template-literal aware so a `)` or `,` inside a handler body or a
// field's default-value string doesn't fool the depth count. Good enough for
// a heuristic extractor (module doc); a mismatched-bracket case bails out
// (-1) rather than guessing.
// ---------------------------------------------------------------------------

const CLOSE_FOR: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Returns the index just after the bracket that matches `content[openIndex]`, or -1 if unbalanced before EOF. */
function skipBalanced(content: string, openIndex: number): number {
  const stack: string[] = [CLOSE_FOR[content[openIndex]]];
  let inString: string | null = null;
  for (let i = openIndex + 1; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push(CLOSE_FOR[ch]);
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (stack[stack.length - 1] !== ch) return -1; // mismatched — bail rather than guess
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Splits `content` on `separator`, but only where bracket depth is 0 — so a nested object's commas don't split a field list apart. */
function splitTopLevel(content: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let inString: string | null = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === separator && depth === 0) {
      parts.push(content.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(content.slice(start));
  return parts;
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

const ROUTE_CHAIN_START_RE = /\b(?:app|router)\s*\.\s*route\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)/g;
const CHAIN_METHOD_RE = /^\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(/i;

/**
 * `router.route('/x').get(h1).post(h2)` — one `.route()` call binds a path,
 * then each chained `.verb(...)` registers a handler for it (ARCHITECTURE.md
 * §16 finding: the plain call-per-verb regex above matches none of these).
 * Walks the chain call-by-call using `skipBalanced` to jump over each
 * handler's argument list, so a handler body containing `.get(` or `,` can't
 * derail the walk.
 */
function detectChainedRoutes(root: string, files: string[]): ApiHit[] {
  const hits: ApiHit[] = [];
  for (const rel of files) {
    const content = readSafe(root, rel);
    if (!content) continue;
    ROUTE_CHAIN_START_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROUTE_CHAIN_START_RE.exec(content)) !== null) {
      const routePath = m[2];
      let pos = ROUTE_CHAIN_START_RE.lastIndex;
      while (true) {
        const methodMatch = CHAIN_METHOD_RE.exec(content.slice(pos));
        if (!methodMatch) break;
        const method = methodMatch[1].toUpperCase();
        hits.push({ method, routePath, file: rel, line: lineAt(content, pos) });
        const openParenIndex = pos + methodMatch[0].length - 1;
        const afterCall = skipBalanced(content, openParenIndex);
        if (afterCall === -1) break; // unbalanced — stop walking this chain rather than guess
        pos = afterCall;
      }
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

// ---------------------------------------------------------------------------
// Router mount-prefix resolution — ARCHITECTURE.md §16/§20 (M6 real-repo find):
// a route file's `.get('/x', ...)` calls only ever captured the path literal
// *inside that one file*, with zero awareness that `app.use('/api/gemini',
// aiRoute)` elsewhere prefixes every route in it. On a real, well-organized
// Express app (many route files, each mounted under its own prefix in the
// entry point), that's not cosmetic: two different real routers using the
// same relative path (`router.get('/:id', ...)` is an extremely common
// pattern) collide under the OLD (method, path)-only de-dupe key below, and
// the de-dupe silently drops one — actual data loss, not just an ambiguous
// label. Confirmed on a real 125-file repo before this was written: 4
// (method, path) collisions across different route files, all real,
// distinct endpoints.
//
// Single-level only: resolves `<app|router>.use('<prefix>', <ident>)` where
// `<ident>` is bound via a same-file `require`/`import` to a route file
// already in the inventory. Does NOT compose prefixes through multiple
// layers of re-exported/nested routers (a router mounted under a router
// that's itself mounted elsewhere) — that needs transitive graph resolution,
// out of scope here; falls back to the old prefix-less behavior for any file
// this can't resolve, so it can only ever add information, never remove any
// route that was already being found.
// ---------------------------------------------------------------------------

const IMPORT_BINDING_RE =
  /\b(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*(['"`])(\.[^'"`]*)\2\s*\)|\bimport\s+([\w$]+)\s+from\s+(['"`])(\.[^'"`]*)\5/g;
const MOUNT_USE_RE = /\b(?:app|router)\s*\.\s*use\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*([\w$]+)\s*\)/g;

/** Resolves a relative import specifier (from `fromFile`) to a real inventory path, trying extension-less/`.js`/`.ts`/index-file variants — no `--target` info available, so all plausible extensions are tried. */
function resolveImportPath(fromFile: string, importPath: string, knownPaths: Set<string>): string | null {
  const baseDir = path.dirname(fromFile);
  const raw = path.normalize(path.join(baseDir, importPath)).split(path.sep).join("/");
  for (const candidate of [raw, `${raw}.js`, `${raw}.ts`, `${raw}/index.js`, `${raw}/index.ts`]) {
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}

/** File path -> mount prefix(es) it's registered under, resolved as described above. */
function buildMountPrefixMap(root: string, files: string[]): Map<string, string[]> {
  const knownPaths = new Set(files);
  const map = new Map<string, string[]>();

  for (const rel of files) {
    const content = readSafe(root, rel);
    if (!content) continue;

    const localImports = new Map<string, string>(); // identifier -> resolved file path, scoped to this one file
    IMPORT_BINDING_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = IMPORT_BINDING_RE.exec(content)) !== null) {
      const ident = im[1] ?? im[4];
      const importPath = im[3] ?? im[6];
      const resolved = resolveImportPath(rel, importPath, knownPaths);
      if (resolved) localImports.set(ident, resolved);
    }
    if (localImports.size === 0) continue;

    MOUNT_USE_RE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = MOUNT_USE_RE.exec(content)) !== null) {
      const target = localImports.get(mm[3]);
      if (!target) continue; // second arg isn't something we traced back to a file — likely inline middleware, not a router; safe to skip
      const prefix = mm[2];
      if (!map.has(target)) map.set(target, []);
      if (!map.get(target)!.includes(prefix)) map.get(target)!.push(prefix);
    }
  }

  return map;
}

function joinRoutePath(prefix: string, routePath: string): string {
  const combined = `${prefix}${routePath}`.replace(/\/{2,}/g, "/");
  return combined.length > 1 && combined.endsWith("/") ? combined.slice(0, -1) : combined;
}

/** Applies resolved mount prefixes to Express-style hits; a file with no resolvable prefix is passed through unchanged (old behavior). A file mounted under more than one prefix produces one hit per prefix — it really is reachable at each. */
function applyMountPrefixes(hits: ApiHit[], mountPrefixes: Map<string, string[]>): ApiHit[] {
  const resolved: ApiHit[] = [];
  for (const hit of hits) {
    const prefixes = mountPrefixes.get(hit.file);
    if (!prefixes || prefixes.length === 0) {
      resolved.push(hit);
      continue;
    }
    for (const prefix of prefixes) {
      resolved.push({ ...hit, routePath: joinRoutePath(prefix, hit.routePath) });
    }
  }
  return resolved;
}

export function analyzeApiEndpoints(
  root: string,
  inventory: Inventory,
  allocator: IdAllocator,
  projectId: string,
): KnowledgeNode[] {
  const sourceFiles = inventory.files.filter((f) => f.kind === "source").map((f) => f.path);

  const expressHits = applyMountPrefixes(
    [...detectExpressStyleRoutes(root, sourceFiles), ...detectChainedRoutes(root, sourceFiles)],
    buildMountPrefixMap(root, sourceFiles),
  );
  const hits = [...expressHits, ...detectNextFileRoutes(root, sourceFiles)];
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

// ---------------------------------------------------------------------------
// Mongoose schemas — ARCHITECTURE.md §16 finding: a real repo's two Mongoose
// models produced zero `db-table` nodes. Two-step, per-file: find
// `new Schema({...})` declarations (capturing top-level field names), then
// find `mongoose.model('Name', schemaVar)` calls and bind the two together by
// variable name. Only within the same file — a schema imported from another
// module and passed to `model()` elsewhere is a known gap (see module doc);
// the model still gets a node in that case, just without field detail.
// ---------------------------------------------------------------------------

/** Gate the (looser) bare `Schema(`/`model(` patterns behind evidence the file actually imports mongoose, so an unrelated `model(...)` call elsewhere doesn't false-positive. */
const MONGOOSE_IMPORT_RE = /\bfrom\s+['"]mongoose['"]|require\(\s*['"]mongoose['"]\s*\)/;
const MONGOOSE_SCHEMA_DECL_RE = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*new\s+(?:mongoose\s*\.\s*)?Schema\s*\(/g;
const MONGOOSE_MODEL_CALL_RE = /\b(?:mongoose\s*\.\s*)?model\s*\(\s*(['"`])([\w$]+)\1\s*,\s*([\w$]+)/g;

/** Best-effort field type from a Mongoose field's value snippet: `String`, `{ type: String, ... }`, `[...]`, or a plain identifier/dotted path. */
function mongooseFieldType(valueSnippet: string): string {
  const trimmed = valueSnippet.trim();
  if (trimmed.startsWith("{")) {
    const typeMatch = /\btype\s*:\s*([\w.[\]]+)/.exec(trimmed);
    return typeMatch ? typeMatch[1] : "object";
  }
  if (trimmed.startsWith("[")) return "array";
  const identMatch = /^[\w.]+/.exec(trimmed);
  return identMatch ? identMatch[0] : "unknown";
}

/** Parses top-level `name: value` pairs out of a Schema object literal's inner content (between the outer `{`/`}`, exclusive). */
function parseMongooseSchemaFields(objectInner: string): string[] {
  const fieldKeyRe = /^\s*(?:(['"])([\w$]+)\1|([\w$]+))\s*:\s*([\s\S]*)$/;
  const fields: string[] = [];
  for (const rawSegment of splitTopLevel(objectInner, ",")) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    const m = fieldKeyRe.exec(segment);
    if (!m) continue;
    const name = m[2] ?? m[3];
    fields.push(`${name}: ${mongooseFieldType(m[4])}`);
  }
  return fields;
}

function analyzeMongooseModels(root: string, relPath: string, allocator: IdAllocator, projectId: string): KnowledgeNode[] {
  const content = readSafe(root, relPath);
  if (!content || !MONGOOSE_IMPORT_RE.test(content)) return [];

  const schemasByVar = new Map<string, { fields: string[] }>();
  MONGOOSE_SCHEMA_DECL_RE.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = MONGOOSE_SCHEMA_DECL_RE.exec(content)) !== null) {
    const varName = sm[1];
    const openParenIndex = MONGOOSE_SCHEMA_DECL_RE.lastIndex - 1;
    // Schema's first argument is usually an inline object literal; a schema
    // built from a separately-declared object (or none at all) just yields
    // no field detail below, same as a `.route()` chain we can't balance.
    const afterOpenParen = content.slice(openParenIndex + 1);
    const braceOffset = /^\s*\{/.exec(afterOpenParen);
    if (!braceOffset) {
      schemasByVar.set(varName, { fields: [] });
      continue;
    }
    const braceIndex = openParenIndex + 1 + braceOffset[0].length - 1;
    const afterBrace = skipBalanced(content, braceIndex);
    const fields = afterBrace === -1 ? [] : parseMongooseSchemaFields(content.slice(braceIndex + 1, afterBrace - 1));
    schemasByVar.set(varName, { fields });
  }

  const nodes: KnowledgeNode[] = [];
  MONGOOSE_MODEL_CALL_RE.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = MONGOOSE_MODEL_CALL_RE.exec(content)) !== null) {
    const modelName = mm[2];
    const schemaVarName = mm[3];
    const schema = schemasByVar.get(schemaVarName);
    const fields = schema?.fields ?? [];
    nodes.push(
      makeNode(allocator, projectId, "SCHEMA", {
        type: "db-table",
        title: modelName,
        content:
          `Mongoose model \`${modelName}\` (schema \`${schemaVarName}\`)` +
          (fields.length
            ? ` with fields:\n\n${fields.map((f) => `- ${f}`).join("\n")}`
            : schema
              ? "."
              : " — schema variable not declared in this file, so field detail wasn't resolved."),
        status: "observed",
        confidence: null,
        evidence: [{ path: relPath, lines: [lineAt(content, mm.index), lineAt(content, mm.index)] }],
      }),
    );
  }
  return nodes;
}

const SOURCE_LIKE_EXTENSIONS = /\.(js|jsx|ts|tsx|mjs|cjs)$/;

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
    else if (f.kind === "source" && SOURCE_LIKE_EXTENSIONS.test(f.path)) {
      nodes.push(...analyzeMongooseModels(root, f.path, allocator, projectId));
    }
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// External services — derived from dependency names stage 2 already extracted
// ---------------------------------------------------------------------------

// ARCHITECTURE.md §20 — kafkajs/socket.io/@google/generative-ai were missing
// from this table, found on a real repo that used all three: the packages
// were still correctly listed as plain `dependency` nodes, just never
// elevated to the more semantic `external-service` type. Low severity (no
// information lost, just under-classified) but a real, concrete gap, not
// hypothetical — added below rather than left as a known-but-unfixed item.
const KNOWN_EXTERNAL_SERVICES: Record<string, string> = {
  stripe: "Stripe",
  "aws-sdk": "AWS SDK",
  "@aws-sdk/client-s3": "AWS S3",
  twilio: "Twilio",
  "@sendgrid/mail": "SendGrid",
  openai: "OpenAI API",
  "@anthropic-ai/sdk": "Anthropic API",
  "@google/generative-ai": "Google Generative AI (Gemini)",
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
  kafkajs: "Kafka (via KafkaJS)",
  "socket.io": "Socket.IO",
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
