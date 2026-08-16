import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runExport } from "../pipeline.js";
import { runCompare } from "./index.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-compare-"));
}

/** A minimal real Express+package.json fixture — extraction runs against real files, not mocked nodes. */
function writeFixture(
  dir: string,
  opts: { routes: string[]; scripts?: Record<string, string> },
): void {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const routeLines = opts.routes.map((r) => `app.get('${r}', (req, res) => res.send('ok'));`).join("\n");
  fs.writeFileSync(path.join(dir, "src", "app.js"), `const app = require('express')();\n${routeLines}\n`);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", scripts: opts.scripts ?? {} }, null, 2),
  );
}

async function originalPkrDir(routes: string[], scripts?: Record<string, string>): Promise<string> {
  const repo = tmpDir();
  writeFixture(repo, { routes, scripts });
  await runExport({ repoRoot: repo, llm: null });
  return path.join(repo, ".projectknowledge");
}

describe("runCompare", () => {
  it("reports a perfect API match as a measured 1.0 score", async () => {
    const pkrDir = await originalPkrDir(["/status", "/health"]);
    const reconRoot = tmpDir();
    writeFixture(reconRoot, { routes: ["/status", "/health"] });

    const result = runCompare({ originalPkrDir: pkrDir, reconstructionRepoDir: reconRoot });
    const apiRow = result.rows.find((r) => r.dimension === "API compatibility")!;
    expect(apiRow.kind).toBe("measured");
    expect(apiRow.score).toBe(1);
    expect(apiRow.summary).toContain("2/2 reproduced");
  });

  it("reports a partial match with missing and extra endpoints listed", async () => {
    const pkrDir = await originalPkrDir(["/status", "/health"]);
    const reconRoot = tmpDir();
    writeFixture(reconRoot, { routes: ["/status", "/metrics"] }); // missing /health, extra /metrics

    const result = runCompare({ originalPkrDir: pkrDir, reconstructionRepoDir: reconRoot });
    const apiRow = result.rows.find((r) => r.dimension === "API compatibility")!;
    expect(apiRow.score).toBe(0.5);
    expect(apiRow.detail).toContain("missing: GET /health");
    expect(apiRow.detail).toContain("extra: GET /metrics");
  });

  it("marks API compatibility not-measurable when the original has no endpoints", async () => {
    const pkrDir = await originalPkrDir([]);
    const reconRoot = tmpDir();
    writeFixture(reconRoot, { routes: ["/status"] });

    const result = runCompare({ originalPkrDir: pkrDir, reconstructionRepoDir: reconRoot });
    const apiRow = result.rows.find((r) => r.dimension === "API compatibility")!;
    expect(apiRow.kind).toBe("not-measurable");
    expect(apiRow.score).toBeNull();
  });

  it("labels architecture similarity as heuristic, never measured", async () => {
    const pkrDir = await originalPkrDir(["/status"]);
    const reconRoot = tmpDir();
    writeFixture(reconRoot, { routes: ["/status"] });

    const result = runCompare({ originalPkrDir: pkrDir, reconstructionRepoDir: reconRoot });
    const archRow = result.rows.find((r) => r.dimension === "Architecture similarity")!;
    expect(archRow.kind).toBe("heuristic");
  });

  it("does not execute the build by default, and says why", async () => {
    const pkrDir = await originalPkrDir(["/status"], { build: "tsc" });
    const reconRoot = tmpDir();
    writeFixture(reconRoot, { routes: ["/status"] });

    const result = runCompare({ originalPkrDir: pkrDir, reconstructionRepoDir: reconRoot });
    const buildRow = result.rows.find((r) => r.dimension === "Build success")!;
    expect(buildRow.kind).toBe("not-measurable");
    expect(buildRow.summary).toContain("--run-build");
  });

  it("marks build not-measurable when the original has no build script, even with runBuild:true", async () => {
    const pkrDir = await originalPkrDir(["/status"]); // no scripts at all
    const reconRoot = tmpDir();
    writeFixture(reconRoot, { routes: ["/status"] });

    const result = runCompare({ originalPkrDir: pkrDir, reconstructionRepoDir: reconRoot, runBuild: true });
    const buildRow = result.rows.find((r) => r.dimension === "Build success")!;
    expect(buildRow.kind).toBe("not-measurable");
    expect(buildRow.summary).toContain("no known");
  });

  it("actually runs the build when runBuild:true and the original had a build script, and reports success", async () => {
    const pkrDir = await originalPkrDir(["/status"], { build: "node -e \"process.exit(0)\"" });
    const reconRoot = tmpDir();
    writeFixture(reconRoot, { routes: ["/status"], scripts: { build: "node -e \"process.exit(0)\"" } });

    const result = runCompare({ originalPkrDir: pkrDir, reconstructionRepoDir: reconRoot, runBuild: true });
    const buildRow = result.rows.find((r) => r.dimension === "Build success")!;
    expect(buildRow.kind).toBe("measured");
    expect(buildRow.score).toBe(1);
  }, 15_000);

  it("actually runs the build when runBuild:true and reports failure with output detail", async () => {
    const pkrDir = await originalPkrDir(["/status"], { build: "node -e \"process.exit(1)\"" });
    const reconRoot = tmpDir();
    writeFixture(reconRoot, { routes: ["/status"], scripts: { build: "node -e \"process.exit(1)\"" } });

    const result = runCompare({ originalPkrDir: pkrDir, reconstructionRepoDir: reconRoot, runBuild: true });
    const buildRow = result.rows.find((r) => r.dimension === "Build success")!;
    expect(buildRow.kind).toBe("measured");
    expect(buildRow.score).toBe(0);
    expect(buildRow.detail).toBeDefined();
  }, 15_000);

  it("computes an equally-weighted overall score across only the scored rows, and prints the weights", async () => {
    const pkrDir = await originalPkrDir(["/status"]); // no build/test scripts -> those rows are not-measurable
    const reconRoot = tmpDir();
    writeFixture(reconRoot, { routes: ["/status"] });

    const result = runCompare({ originalPkrDir: pkrDir, reconstructionRepoDir: reconRoot });
    const scoredDimensions = Object.keys(result.weights);
    expect(scoredDimensions).not.toContain("Build success");
    expect(scoredDimensions).not.toContain("Test success");
    expect(result.overallScore).toBe(1); // API compat measured 1.0, architecture heuristic 1.0
    for (const w of Object.values(result.weights)) {
      expect(w).toBeCloseTo(1 / scoredDimensions.length);
    }
  });

  it("throws a clean error when the reconstruction path doesn't exist", async () => {
    const pkrDir = await originalPkrDir(["/status"]);
    expect(() => runCompare({ originalPkrDir: pkrDir, reconstructionRepoDir: "/this/path/does/not/exist" })).toThrow(/Not a directory/);
  });
});
