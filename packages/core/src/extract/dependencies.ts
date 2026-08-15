/**
 * Stage 2 — Manifest & dependency analysis. ARCHITECTURE.md §2 stage 2.
 *
 * Parses package.json (and a handful of well-known config files) and emits
 * `dependency` and `tech-choice` nodes. Everything here is read directly off
 * a manifest file, so every node is `status: observed` — no judgment calls.
 * Only package.json (Node/TS ecosystem) is supported in this first slice;
 * other ecosystems (pyproject.toml, go.mod, Cargo.toml) are noted as a
 * known gap, not silently ignored — ARCHITECTURE.md §11 (unknowns).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { IdAllocator } from "../ids.js";
import { makeNode } from "../node-factory.js";
import type { KnowledgeNode } from "../types.js";

interface PackageJson {
  name?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** package name -> friendly tech-choice title. Extend as new frameworks matter. */
const KNOWN_FRAMEWORKS: Record<string, string> = {
  next: "Next.js",
  react: "React",
  "react-dom": "React DOM",
  vue: "Vue",
  svelte: "Svelte",
  express: "Express",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  vite: "Vite",
  webpack: "Webpack",
  vitest: "Vitest",
  jest: "Jest",
  "@playwright/test": "Playwright",
  prisma: "Prisma",
  "drizzle-orm": "Drizzle ORM",
  tailwindcss: "Tailwind CSS",
  zod: "Zod",
  commander: "Commander.js",
  typescript: "TypeScript",
};

export interface DependencyAnalysisResult {
  nodes: KnowledgeNode[];
  projectName: string | null;
  projectDescription: string | null;
  /** Raw package names (runtime + dev), for stage 3's external-service lookup. */
  dependencyNames: string[];
  /**
   * `npm run <key>` commands worth re-running to validate a reconstruction —
   * feeds `reconstruction/validation.md` (M2, ARCHITECTURE.md §4). Only
   * `build` and `test`, since those are the two npm-ecosystem conventions
   * consistent enough to trust without guessing.
   */
  validationCommands: Record<string, string>;
}

export function analyzeDependencies(
  root: string,
  allocator: IdAllocator,
  projectId: string,
): DependencyAnalysisResult {
  const nodes: KnowledgeNode[] = [];
  const pkgPath = path.join(root, "package.json");

  if (!fs.existsSync(pkgPath)) {
    return { nodes, projectName: null, projectDescription: null, dependencyNames: [], validationCommands: {} };
  }

  const pkg: PackageJson = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const seenFrameworks = new Set<string>();

  const allDeps: Array<[string, string, "runtime" | "dev"]> = [
    ...Object.entries(pkg.dependencies ?? {}).map<[string, string, "runtime"]>(([n, v]) => [n, v, "runtime"]),
    ...Object.entries(pkg.devDependencies ?? {}).map<[string, string, "dev"]>(([n, v]) => [n, v, "dev"]),
  ];

  for (const [name, versionRange, kind] of allDeps) {
    nodes.push(
      makeNode(allocator, projectId, "DEPS", {
        type: "dependency",
        title: `${name} (${versionRange})`,
        content: `${name} is a ${kind} dependency, declared in package.json with version range \`${versionRange}\`.`,
        status: "observed",
        confidence: null,
        evidence: [{ path: "package.json" }],
      }),
    );

    const friendly = KNOWN_FRAMEWORKS[name];
    if (friendly && !seenFrameworks.has(friendly)) {
      seenFrameworks.add(friendly);
      nodes.push(
        makeNode(allocator, projectId, "STACK", {
          type: "tech-choice",
          title: friendly,
          content: `The project uses ${friendly} (via the \`${name}\` package in package.json).`,
          status: "observed",
          confidence: null,
          evidence: [{ path: "package.json" }],
        }),
      );
    }
  }

  const hasTsconfig = fs.existsSync(path.join(root, "tsconfig.json"));
  if (hasTsconfig && !seenFrameworks.has("TypeScript")) {
    nodes.push(
      makeNode(allocator, projectId, "STACK", {
        type: "tech-choice",
        title: "TypeScript",
        content: "The project is written in TypeScript (tsconfig.json present at the repository root).",
        status: "observed",
        confidence: null,
        evidence: [{ path: "tsconfig.json" }],
      }),
    );
  }

  const validationCommands: Record<string, string> = {};
  for (const key of ["build", "test"] as const) {
    const script = pkg.scripts?.[key];
    if (script) validationCommands[key] = `npm run ${key}`;
  }

  return {
    nodes,
    projectName: pkg.name ?? null,
    projectDescription: pkg.description ?? null,
    dependencyNames: allDeps.map(([name]) => name),
    validationCommands,
  };
}
