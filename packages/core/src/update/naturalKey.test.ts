import { describe, it, expect } from "vitest";
import { naturalKey } from "./naturalKey.js";
import type { KnowledgeNode } from "../types.js";

function fakeNode(type: KnowledgeNode["type"], title: string): KnowledgeNode {
  return { type, title } as KnowledgeNode;
}

describe("naturalKey", () => {
  it("strips the version range off a dependency title so a version bump doesn't look like a new package", () => {
    expect(naturalKey(fakeNode("dependency", "zod (^3.23.8)"))).toBe("zod");
    expect(naturalKey(fakeNode("dependency", "zod (^3.24.0)"))).toBe("zod");
  });

  it("uses the raw title for every other natural-key type", () => {
    expect(naturalKey(fakeNode("component", "Auth service"))).toBe("Auth service");
    expect(naturalKey(fakeNode("api-endpoint", "GET /users/:id"))).toBe("GET /users/:id");
  });

  it("falls back to the full title when a dependency title has no version-range parens", () => {
    expect(naturalKey(fakeNode("dependency", "zod"))).toBe("zod");
  });
});
