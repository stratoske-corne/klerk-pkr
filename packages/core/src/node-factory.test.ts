import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IdAllocator } from "./ids.js";
import { makeNode, makeInferredNode } from "./node-factory.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-nf-"));
}

describe("makeNode", () => {
  let allocator: IdAllocator;

  beforeEach(() => {
    allocator = IdAllocator.load(tmpDir());
  });

  it("allocates an ID, stamps timestamps, and validates against the schema", () => {
    const node = makeNode(allocator, "proj", "AUTH", {
      type: "component",
      title: "Auth service",
      content: "Handles login.",
      status: "observed",
      confidence: null,
      evidence: [{ path: "src/auth.ts" }],
    });

    expect(node.id).toMatch(/^ARCH-AUTH-001$/);
    expect(node.project_id).toBe("proj");
    expect(node.confirmed_by).toBeNull();
    expect(node.supersedes).toBeNull();
    expect(node.created_at).toBe(node.updated_at);
  });

  it("rejects (throws) a status:observed node with no evidence — PKR_SPEC.md §4.1", () => {
    expect(() =>
      makeNode(allocator, "proj", "AUTH", {
        type: "component",
        title: "Auth service",
        content: "Handles login.",
        status: "observed",
        confidence: null,
        evidence: [],
      }),
    ).toThrow();
  });

  it("rejects a status:inferred node with null confidence", () => {
    expect(() =>
      makeNode(allocator, "proj", "AUTH", {
        type: "domain-concept",
        title: "Guess",
        content: "Maybe true.",
        status: "inferred",
        confidence: null,
        evidence: [{ path: "src/auth.ts" }],
      }),
    ).toThrow();
  });

  it("rejects a non-inferred node that carries a confidence value", () => {
    expect(() =>
      makeNode(allocator, "proj", "AUTH", {
        type: "component",
        title: "Auth service",
        content: "Handles login.",
        status: "observed",
        confidence: 0.9,
        evidence: [{ path: "src/auth.ts" }],
      }),
    ).toThrow();
  });
});

describe("makeInferredNode", () => {
  it("always produces status:inferred with the given confidence — cannot emit observed", () => {
    const allocator = IdAllocator.load(tmpDir());
    const node = makeInferredNode(allocator, "proj", "PROD", {
      type: "requirement",
      title: "Users can reset their password",
      content: "Inferred from a /forgot-password route and a mailer call nearby.",
      confidence: 0.7,
      evidence: [{ path: "src/routes/auth.ts", lines: [10, 25] }],
    });

    expect(node.status).toBe("inferred");
    expect(node.confidence).toBe(0.7);
  });
});
