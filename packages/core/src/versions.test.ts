import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { commitVersion, listVersions, summarizeChanges, type ChangedNode } from "./versions.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-versions-"));
}

describe("commitVersion", () => {
  it("writes v0.1 with parent_version null on the first commit", () => {
    const dir = tmpDir();
    const version = commitVersion(dir, {
      summary: "Initial export",
      changedNodes: [{ id: "REQ-AUTH-001", change: "added" }],
      sourceCommit: "abc123",
    });
    expect(version).toBe("v0.1");
    const versions = listVersions(dir);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: "v0.1", parent_version: null, source_commit: "abc123" });
  });

  it("increments sequentially and chains parent_version, reading state back from disk only", () => {
    const dir = tmpDir();
    commitVersion(dir, { summary: "Initial export", changedNodes: [{ id: "REQ-AUTH-001", change: "added" }], sourceCommit: null });
    const v2 = commitVersion(dir, { summary: "Update", changedNodes: [{ id: "REQ-AUTH-001", change: "modified" }], sourceCommit: null });
    expect(v2).toBe("v0.2");
    const versions = listVersions(dir);
    expect(versions.map((v) => v.version)).toEqual(["v0.1", "v0.2"]);
    expect(versions[1].parent_version).toBe("v0.1");
  });

  it("writes nothing and returns null when there are no changed nodes", () => {
    const dir = tmpDir();
    const version = commitVersion(dir, { summary: "No-op", changedNodes: [], sourceCommit: null });
    expect(version).toBeNull();
    expect(listVersions(dir)).toHaveLength(0);
  });

  it("always attributes the auto-commit to the extractor, not a human", () => {
    const dir = tmpDir();
    commitVersion(dir, { summary: "Initial export", changedNodes: [{ id: "REQ-AUTH-001", change: "added" }], sourceCommit: null });
    expect(listVersions(dir)[0].author).toBe("extractor:pkr-cli@0.1.0");
  });

  it("omits the optional reason field entirely when not given, rather than writing an empty one", () => {
    const dir = tmpDir();
    commitVersion(dir, { summary: "Initial export", changedNodes: [{ id: "REQ-AUTH-001", change: "added" }], sourceCommit: null });
    expect(listVersions(dir)[0].reason).toBeUndefined();
  });
});

describe("listVersions", () => {
  it("returns an empty array when nothing has been committed yet", () => {
    expect(listVersions(tmpDir())).toEqual([]);
  });
});

describe("summarizeChanges", () => {
  it("formats a mix of change kinds concisely", () => {
    const changed: ChangedNode[] = [
      { id: "A", change: "added" },
      { id: "B", change: "added" },
      { id: "C", change: "modified" },
      { id: "D", change: "removed" },
      { id: "E", change: "superseded" },
      { id: "F", change: "conflict" },
    ];
    expect(summarizeChanges(changed)).toBe("+2, ~1, -1, 1 superseded, 1 conflict(s) — needs review");
  });

  it("omits zero-count categories", () => {
    expect(summarizeChanges([{ id: "A", change: "added" }])).toBe("+1");
  });
});
