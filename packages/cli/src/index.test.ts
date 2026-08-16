/**
 * Actually spawns the compiled `bin/pkr.js` as a real subprocess — every
 * other test in this project (packages/core) calls `runExport`/`runUpdate`/
 * etc. directly, which never exercises this package at all. Added after
 * manually running the CLI the way a first-time user actually would (wrong
 * paths, no PKR yet, typos) and finding every one of those crashed with a
 * raw Node.js stack trace pointing into compiled `dist/` files, instead of
 * the clean, already-well-written error message the underlying `Error`
 * carried. Requires `npm run build` to have already produced `dist/` for
 * both `@klerk/core` and `@klerk/cli` — this spawns the built artifact, the
 * same thing a real user runs, not the TypeScript source.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const CLI_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "pkr.js");

function runCli(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ANTHROPIC_API_KEY: "", ...env }, // never accidentally make a real API call from a test
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-cli-"));
}

function fixtureRepo(): string {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "index.js"), "console.log('hi');\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2));
  return dir;
}

beforeAll(() => {
  if (!fs.existsSync(path.resolve(path.dirname(CLI_BIN), "..", "dist", "index.js"))) {
    throw new Error("packages/cli/dist/index.js is missing — run `npm run build` before the CLI test suite.");
  }
});

describe("pkr CLI — basic dispatch (commander's own behavior, baseline coverage)", () => {
  it("prints usage and exits 1 with no arguments", () => {
    const { stdout, stderr, status } = runCli([]);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain("Usage: pkr");
  });

  it("prints the version and exits 0", () => {
    const { stdout, status } = runCli(["--version"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("0.1.0");
  });

  it("rejects an unknown command", () => {
    const { stderr, status } = runCli(["frobnicate"]);
    expect(status).toBe(1);
    expect(stderr).toContain("unknown command");
  });

  it("rejects export with a missing required argument", () => {
    const { stderr, status } = runCli(["export"]);
    expect(status).toBe(1);
    expect(stderr).toContain("missing required argument");
  });
});

describe("pkr CLI — clean error messages, not raw crashes (REGRESSION)", () => {
  it("export on a nonexistent path: clean message, exit 1, no stack trace", () => {
    const { stdout, stderr, status } = runCli(["export", "/this/path/does/not/exist"]);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain("Error: Not a directory");
    expect(stdout + stderr).not.toMatch(/at \S+ \(/); // a JS stack trace frame would look like "at foo (file://...)"
    expect(stdout + stderr).not.toContain("node_modules/commander"); // internals must never leak to the user
  });

  it("update on a real directory with no existing PKR: clean message, exit 1, no stack trace", () => {
    const dir = fixtureRepo();
    const { stdout, stderr, status } = runCli(["update", dir]);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain("run `pkr export` (or `pkr init`) first");
    expect(stdout + stderr).not.toMatch(/at \S+ \(/);
  });

  it("context on a directory with no manifest.yaml: clean message, exit 1, no stack trace", () => {
    const dir = fixtureRepo(); // a real directory, but not a PKR
    const { stdout, stderr, status } = runCli(["context", dir]);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain("Not a Project Knowledge Repository");
    expect(stdout + stderr).not.toMatch(/at \S+ \(/);
  });

  it("reconstruct on a nonexistent path: clean message, exit 1, no stack trace", () => {
    const { stdout, stderr, status } = runCli(["reconstruct", "/this/path/does/not/exist"]);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain("Error: Not a directory");
    expect(stdout + stderr).not.toMatch(/at \S+ \(/);
  });

  it("log on a directory with no manifest.yaml: clean message, exit 1, no stack trace", () => {
    const dir = fixtureRepo();
    const { stdout, stderr, status } = runCli(["log", dir]);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain("Not a Project Knowledge Repository");
    expect(stdout + stderr).not.toMatch(/at \S+ \(/);
  });

  it("PKR_DEBUG=1 opts back into seeing the full stack trace", () => {
    const { stdout, stderr } = runCli(["export", "/this/path/does/not/exist"], { PKR_DEBUG: "1" });
    expect(stdout + stderr).toMatch(/at \S+ \(/);
  });
});

describe("pkr CLI — real happy-path smoke test (no LLM, no network)", () => {
  it("export produces a real .projectknowledge/ directory via the actual compiled CLI", () => {
    const dir = fixtureRepo();
    const { stdout, status } = runCli(["export", dir]);
    expect(status).toBe(0);
    expect(stdout).toContain("Wrote");
    expect(fs.existsSync(path.join(dir, ".projectknowledge", "manifest.yaml"))).toBe(true);
  });

  it("the `init` alias behaves identically to `export`", () => {
    const dir = fixtureRepo();
    const { status } = runCli(["init", dir]);
    expect(status).toBe(0);
    expect(fs.existsSync(path.join(dir, ".projectknowledge", "manifest.yaml"))).toBe(true);
  });
});

describe("pkr CLI — `update`'s modified-node line (REGRESSION, ARCHITECTURE.md §21)", () => {
  // A node's title only embeds what an extractor puts in it (e.g. an
  // api-endpoint's "METHOD /path") — plenty of real edits change a node's
  // *content* or *evidence* (line number) without touching its title. The
  // old `before.title → after.title` line degenerated to `X → X` in exactly
  // that — the common — case. Reproduced here by shifting an existing
  // route's line number (a blank line inserted above it) without touching
  // its method or path.
  it("reports what actually changed, not `title → title`, when a route's line moves but its signature doesn't", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2));
    fs.writeFileSync(path.join(dir, "src", "app.js"), "const app = require('express')();\napp.get('/status', (req, res) => res.send('ok'));\n");

    expect(runCli(["export", dir]).status).toBe(0);

    // Same method, same path — only the line it's declared on moves.
    fs.writeFileSync(
      dir + "/src/app.js",
      "const app = require('express')();\n\n// unrelated comment inserted above the route\napp.get('/status', (req, res) => res.send('ok'));\n",
    );

    const { stdout, status } = runCli(["update", dir]);
    expect(status).toBe(0);
    expect(stdout).toContain("~ ");
    expect(stdout).toContain("GET /status (evidence changed)");
    expect(stdout).not.toContain("GET /status → GET /status");
  });

  it("still shows `before → after` when the title itself changed", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "index.js"), "console.log('hi');\n");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, null, 2),
    );

    expect(runCli(["export", dir]).status).toBe(0);

    // A `dependency` node's title embeds the version range ("express
    // (^4.18.0)"); naturalKey strips it back to the package name for
    // matching, so this is still one continuous fact, genuinely retitled.
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { express: "^4.19.0" } }, null, 2),
    );

    const { stdout, status } = runCli(["update", dir]);
    expect(status).toBe(0);
    expect(stdout).toContain("express (^4.18.0) → express (^4.19.0)");
  });
});

describe("pkr CLI — Knowledge Versioning (ARCHITECTURE.md §24)", () => {
  it("export commits v0.1 and reports it; `pkr log` then shows it, newest first", () => {
    const dir = fixtureRepo();
    const exportOut = runCli(["export", dir]);
    expect(exportOut.status).toBe(0);
    expect(exportOut.stdout).toContain("Knowledge version: v0.1");

    const logOut = runCli(["log", path.join(dir, ".projectknowledge")]);
    expect(logOut.status).toBe(0);
    expect(logOut.stdout).toContain("v0.1");
    expect(logOut.stdout).toContain("extractor:pkr-cli@0.1.0");
    expect(logOut.stdout).toContain("(none — initial version)");
  });

  it("a real update bumps to v0.2 and `pkr log` shows both, newest first", () => {
    const dir = fixtureRepo();
    expect(runCli(["export", dir]).status).toBe(0);

    fs.writeFileSync(path.join(dir, "src", "app.js"), "const app = require('express')();\napp.get('/status', (req, res) => res.send('ok'));\n");
    const updateOut = runCli(["update", dir]);
    expect(updateOut.status).toBe(0);
    expect(updateOut.stdout).toContain("Committed knowledge version: v0.2");

    const logOut = runCli(["log", path.join(dir, ".projectknowledge")]);
    const v2Index = logOut.stdout.indexOf("v0.2");
    const v1Index = logOut.stdout.indexOf("v0.1");
    expect(v2Index).toBeGreaterThanOrEqual(0);
    expect(v1Index).toBeGreaterThan(v2Index); // newest first
  });

  it("a no-op update reports no new version, and `pkr log` still shows only v0.1", () => {
    const dir = fixtureRepo();
    expect(runCli(["export", dir]).status).toBe(0);

    const updateOut = runCli(["update", dir]);
    expect(updateOut.status).toBe(0);
    expect(updateOut.stdout).toContain("Up to date");

    const logOut = runCli(["log", path.join(dir, ".projectknowledge")]);
    expect(logOut.stdout).toContain("v0.1");
    expect(logOut.stdout).not.toContain("v0.2");
  });
});
