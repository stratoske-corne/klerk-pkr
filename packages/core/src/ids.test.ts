import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IdAllocator } from "./ids.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-ids-"));
}

describe("IdAllocator", () => {
  it("allocates sequential IDs per (prefix, domain) key, starting at 001", () => {
    const allocator = IdAllocator.load(tmpDir());
    expect(allocator.next("component", "auth")).toBe("ARCH-AUTH-001");
    expect(allocator.next("component", "auth")).toBe("ARCH-AUTH-002");
    expect(allocator.next("component", "billing")).toBe("ARCH-BILLING-001"); // independent counter
  });

  it("normalizes domain to uppercase and strips non-alphanumerics", () => {
    const allocator = IdAllocator.load(tmpDir());
    expect(allocator.next("dependency", "my cool/domain!!")).toBe("TECH-MY-COOL-DOMAIN-001");
  });

  it("treats decisions as sequential and domain-less, 4-digit padded", () => {
    const allocator = IdAllocator.load(tmpDir());
    expect(allocator.next("decision")).toBe("DEC-0001");
    expect(allocator.next("decision")).toBe("DEC-0002");
  });

  it("requires a domain for every non-decision type", () => {
    const allocator = IdAllocator.load(tmpDir());
    expect(() => allocator.next("component")).toThrow();
  });

  it("pads to 4 digits once a counter passes 999", () => {
    const dir = tmpDir();
    const allocator = IdAllocator.load(dir);
    for (let i = 0; i < 999; i++) allocator.next("dependency", "DEPS");
    expect(allocator.next("dependency", "DEPS")).toBe("TECH-DEPS-1000");
  });

  it("persists counters across save/load so IDs are never reused", () => {
    const dir = tmpDir();
    const first = IdAllocator.load(dir);
    first.next("component", "auth");
    first.next("component", "auth");
    first.save();

    const second = IdAllocator.load(dir);
    expect(second.next("component", "auth")).toBe("ARCH-AUTH-003");
  });
});
