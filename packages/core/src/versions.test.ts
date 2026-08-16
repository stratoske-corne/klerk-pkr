import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { commitVersion, listVersions, summarizeChanges, diffVersions, type ChangedNode } from "./versions.js";

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

describe("diffVersions", () => {
  function commitThree(dir: string): void {
    commitVersion(dir, { summary: "v1", changedNodes: [{ id: "A", change: "added" }], sourceCommit: null }); // v0.1
    commitVersion(dir, { summary: "v2", changedNodes: [{ id: "B", change: "added" }], sourceCommit: null }); // v0.2
    commitVersion(dir, { summary: "v3", changedNodes: [{ id: "A", change: "modified" }], sourceCommit: null }); // v0.3
  }

  it("aggregates changed_nodes across every version strictly after `from` up to and including `to`", () => {
    const dir = tmpDir();
    commitThree(dir);
    const result = diffVersions(dir, "v0.1", "v0.3");
    expect(result).toMatchObject({ from: "v0.1", to: "v0.3" });
    expect(result.entries).toEqual([
      { id: "B", change: "added", version: "v0.2" },
      { id: "A", change: "modified", version: "v0.3" },
    ]);
  });

  it("defaults `to` to the latest committed version when omitted", () => {
    const dir = tmpDir();
    commitThree(dir);
    const result = diffVersions(dir, "v0.1");
    expect(result.to).toBe("v0.3");
  });

  it("returns no entries when `from` and `to` are the same version", () => {
    const dir = tmpDir();
    commitThree(dir);
    const result = diffVersions(dir, "v0.2", "v0.2");
    expect(result.entries).toEqual([]);
  });

  it("rejects a reversed range with a helpful hint", () => {
    const dir = tmpDir();
    commitThree(dir);
    expect(() => diffVersions(dir, "v0.3", "v0.1")).toThrow(/not an ancestor.*did you mean `pkr diff v0.1 v0.3`/);
  });

  it("rejects an unknown version by name", () => {
    const dir = tmpDir();
    commitThree(dir);
    expect(() => diffVersions(dir, "v0.99", "v0.3")).toThrow(/Unknown version "v0.99"/);
  });

  it("throws a clear error when nothing has been committed yet", () => {
    expect(() => diffVersions(tmpDir(), "v0.1")).toThrow(/No knowledge versions committed yet/);
  });
});
