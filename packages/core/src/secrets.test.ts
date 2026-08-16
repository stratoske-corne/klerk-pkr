import { describe, it, expect } from "vitest";
import { scanForSecrets, redactSecrets } from "./secrets.js";

describe("scanForSecrets", () => {
  it("detects an AWS access key", () => {
    const matches = scanForSecrets("key = AKIAIOSFODNN7EXAMPLE");
    expect(matches.some((m) => m.reason === "AWS access key")).toBe(true);
  });

  it("detects a GitHub token", () => {
    const matches = scanForSecrets("ghp_1234567890abcdefghijklmnopqrstuvwxyz12");
    expect(matches.some((m) => m.reason === "GitHub token")).toBe(true);
  });

  it("detects a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----";
    const matches = scanForSecrets(pem);
    expect(matches.some((m) => m.reason === "private key block")).toBe(true);
  });

  it("detects a generic assigned secret-shaped value", () => {
    const matches = scanForSecrets('password = "correcthorsebatterystaple1234"');
    expect(matches.some((m) => m.reason === "assigned high-entropy secret-shaped value")).toBe(true);
  });

  it("does not flag ordinary prose or short identifiers", () => {
    const matches = scanForSecrets("This module handles user authentication and password hashing.");
    expect(matches).toHaveLength(0);
  });

  // REGRESSION (found via a deliberate security self-review, not a fixture):
  // the generic pattern used to require a `\b` right before the keyword,
  // which fails whenever the keyword is compounded onto a prefix with no
  // real word-boundary before it (`_` and a case change both still count as
  // "word" to `\b`) — silently missing the single most common real .env
  // variable shape.
  it("detects a prefixed env-var secret ('ANTHROPIC_API_KEY=...')", () => {
    const matches = scanForSecrets("ANTHROPIC_API_KEY=sk-ant-api03-realisticlookingvalue1234567890");
    expect(matches.some((m) => m.reason === "assigned high-entropy secret-shaped value")).toBe(true);
  });

  it("detects a prefixed env-var secret ('DATABASE_PASSWORD=...')", () => {
    const matches = scanForSecrets("DATABASE_PASSWORD=correcthorsebatterystaple1234");
    expect(matches.some((m) => m.reason === "assigned high-entropy secret-shaped value")).toBe(true);
  });

  it("detects a camelCase compound secret identifier ('jwtSecret = ...')", () => {
    const matches = scanForSecrets('jwtSecret = "correcthorsebatterystaple1234"');
    expect(matches.some((m) => m.reason === "assigned high-entropy secret-shaped value")).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("replaces every match with a fixed placeholder, never the original value", () => {
    const { text, redactions } = redactSecrets("aws_key = AKIAIOSFODNN7EXAMPLE and nothing else");
    expect(text).toContain("[REDACTED:AWS access key]");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redactions).toHaveLength(1);
  });

  it("is a no-op on text with nothing secret-shaped", () => {
    const { text, redactions } = redactSecrets("Just a normal sentence about the render pipeline.");
    expect(text).toBe("Just a normal sentence about the render pipeline.");
    expect(redactions).toHaveLength(0);
  });
});
