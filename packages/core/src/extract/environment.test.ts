/**
 * Stage 5 (ARCHITECTURE.md §2/§28) — previously "not built" in §0's status
 * table. Env-var-name scanning is the security-sensitive half: several
 * cases here exist specifically to prove a real `.env` (not `.env.example`)
 * is never opened, and that only the variable *name* — never anything
 * after `=` — ever reaches a node (PKR_SPEC.md §10).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IdAllocator } from "../ids.js";
import { analyzeEnvironment } from "./environment.js";
import type { Inventory, FileKind } from "./inventory.js";

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-env-"));
}

function writeFile(root: string, relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function file(p: string, kind: FileKind = "source") {
  return { path: p, kind, sizeBytes: 1, sha256: "irrelevant" };
}

function inventoryOf(root: string, files: ReturnType<typeof file>[]): Inventory {
  return { root, files };
}

describe("analyzeEnvironment", () => {
  let root: string;

  beforeEach(() => {
    root = tmpRepo();
  });

  it("reports a test file inventory count with bounded evidence", () => {
    const inventory = inventoryOf(root, [file("src/a.test.ts", "test"), file("src/b.test.ts", "test"), file("src/index.ts")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    const testNode = nodes.find((n) => n.title === "Test file inventory")!;
    expect(testNode.content).toContain("2 test file(s)");
    expect(testNode.evidence).toHaveLength(2);
  });

  it("emits no test-inventory node when there are no test files", () => {
    const inventory = inventoryOf(root, [file("src/index.ts")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.find((n) => n.title === "Test file inventory")).toBeUndefined();
  });

  it("detects env var names referenced via process.env.NAME in source", () => {
    writeFile(root, "src/config.js", "const dbUrl = process.env.DATABASE_URL;\nconst port = process.env.PORT;\n");
    const inventory = inventoryOf(root, [file("src/config.js")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    const envNode = nodes.find((n) => n.title === "Environment variables referenced")!;
    expect(envNode.content).toContain("`DATABASE_URL`");
    expect(envNode.content).toContain("`PORT`");
  });

  it("detects env var names via bracket access process.env['NAME']", () => {
    writeFile(root, "src/config.js", "const key = process.env['API_KEY'];\n");
    const inventory = inventoryOf(root, [file("src/config.js")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    const envNode = nodes.find((n) => n.title === "Environment variables referenced")!;
    expect(envNode.content).toContain("`API_KEY`");
  });

  it("reads .env.example for var names", () => {
    writeFile(root, ".env.example", "DATABASE_URL=postgres://user:pass@localhost/db\nAPI_KEY=changeme\n");
    const inventory = inventoryOf(root, [file(".env.example", "config")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    const envNode = nodes.find((n) => n.title === "Environment variables referenced")!;
    expect(envNode.content).toContain("`DATABASE_URL`");
    expect(envNode.content).toContain("`API_KEY`");
  });

  // Two independent guarantees, tested separately so a broken filename
  // filter can't hide behind the fact that the regex also happens to
  // discard values: (1) a real `.env` is never scanned for names AT ALL —
  // proven by a name that exists *only* in `.env` never appearing anywhere;
  // (2) even if a value did somehow reach the scanner, only the key before
  // `=` is ever kept.
  it("never scans a real .env file at all — a var name that exists only there never appears", () => {
    writeFile(root, ".env", "ONLY_IN_REAL_ENV_FILE=somevalue\n");
    const inventory = inventoryOf(root, [file(".env", "config")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.find((n) => n.title === "Environment variables referenced")).toBeUndefined();
  });

  it("never records a value, even from .env.example, only the key", () => {
    writeFile(root, ".env.example", "DATABASE_URL=postgres://user:pass@localhost/db\n");
    const inventory = inventoryOf(root, [file(".env.example", "config")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    expect(JSON.stringify(nodes)).not.toContain("postgres://user:pass@localhost/db");
  });

  it("never includes a value from .env.example, only the key", () => {
    writeFile(root, ".env.example", "SOME_TOKEN=abcdef1234567890\n");
    const inventory = inventoryOf(root, [file(".env.example", "config")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    const envNode = nodes.find((n) => n.title === "Environment variables referenced")!;
    expect(envNode.content).toContain("`SOME_TOKEN`");
    expect(envNode.content).not.toContain("abcdef1234567890");
  });

  it("emits no env-vars node when nothing references any", () => {
    writeFile(root, "src/index.js", "console.log('hi');\n");
    const inventory = inventoryOf(root, [file("src/index.js")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.find((n) => n.title === "Environment variables referenced")).toBeUndefined();
  });

  it("detects GitHub Actions CI config", () => {
    const inventory = inventoryOf(root, [file(".github/workflows/ci.yml", "infra")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.find((n) => n.title === "CI/deploy: GitHub Actions")).toBeDefined();
  });

  it("detects Docker and Docker Compose separately", () => {
    const inventory = inventoryOf(root, [file("Dockerfile", "infra"), file("docker-compose.yml", "infra")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.find((n) => n.title === "CI/deploy: Docker")).toBeDefined();
    expect(nodes.find((n) => n.title === "CI/deploy: Docker Compose")).toBeDefined();
  });

  it("emits no CI/deploy nodes when none of the known markers are present", () => {
    const inventory = inventoryOf(root, [file("src/index.ts")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.filter((n) => n.title.startsWith("CI/deploy:"))).toHaveLength(0);
  });

  it("every emitted node is status: observed with null confidence and at least one evidence ref", () => {
    writeFile(root, "src/config.js", "process.env.PORT;\n");
    const inventory = inventoryOf(root, [file("src/config.js"), file(".github/workflows/ci.yml", "infra"), file("src/a.test.ts", "test")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(n.status).toBe("observed");
      expect(n.confidence).toBeNull();
      expect(n.evidence.length).toBeGreaterThan(0);
    }
  });

  it("returns nothing for a repo with no tests, no env vars, and no CI/deploy config", () => {
    writeFile(root, "src/index.js", "console.log('hi');\n");
    const inventory = inventoryOf(root, [file("src/index.js")]);
    const nodes = analyzeEnvironment(root, inventory, IdAllocator.load(tmpRepo()), "proj");
    expect(nodes).toEqual([]);
  });
});
