/**
 * `buildExcerpts()`'s file-selection heuristic isn't exported directly —
 * tested here through the public `synthesizeProductAndBehavior()`, whose
 * `excerptFiles` result exposes exactly what got selected. A no-op fake LLM
 * (zero nodes back) keeps these tests free and fast; they're about selection,
 * not synthesis quality.
 *
 * The `docs/` and largest-source-file cases below are regression tests for
 * ARCHITECTURE.md §16 Run 3: a real API call on a real (synthetic) repo
 * showed the synthesis was shallow because the file with the actual business
 * logic (`pointsService.js`) and the file explaining its rationale
 * (`docs/DECISIONS.md`) were never selected as excerpts at all.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IdAllocator } from "../ids.js";
import { makeNode, makeInferredNode } from "../node-factory.js";
import { buildInventory } from "./inventory.js";
import { synthesizeProductAndBehavior } from "./synthesize.js";
import type { LlmClient, LlmCompletionParams } from "../llm/client.js";
import type { KnowledgeNode } from "../types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-synth-"));
}

const noopLlm: LlmClient = {
  async complete() {
    return JSON.stringify({ nodes: [] });
  },
};

async function excerptsFor(root: string) {
  const inventory = buildInventory(root);
  const allocator = IdAllocator.load(tmpDir());
  const result = await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, noopLlm);
  return result.excerptFiles;
}

describe("synthesizeProductAndBehavior excerpt selection", () => {
  it("includes a docs/ subdirectory file, not just bare-root docs (Run 3 regression)", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "DECISIONS.md"), "# Decisions\nWhy things are the way they are.\n");

    const excerpts = await excerptsFor(root);
    expect(excerpts).toContain("docs/DECISIONS.md");
  });

  it("does not reach into a nested docs subdirectory (bounded to one level down)", async () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "docs", "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "deep", "notes.md"), "# Notes\n");

    const excerpts = await excerptsFor(root);
    expect(excerpts).not.toContain("docs/deep/notes.md");
  });

  it("falls back to the largest source file when nothing else surfaces it (Run 3 regression)", async () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "src", "services"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "routes"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "services", "big.js"), "// real business logic\n".repeat(200));
    fs.writeFileSync(path.join(root, "src", "routes", "small.js"), "// thin routing only\n");

    const excerpts = await excerptsFor(root);
    expect(excerpts).toContain("src/services/big.js");
  });

  it("still includes README and entry points alongside the size fallback", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "server.js"), "// entry point\n");
    fs.writeFileSync(path.join(root, "src", "big.js"), "// business logic\n".repeat(200));

    const excerpts = await excerptsFor(root);
    expect(excerpts).toEqual(expect.arrayContaining(["README.md", "src/server.js", "src/big.js"]));
  });
});

// ---------------------------------------------------------------------------
// Priority for `pkr update`'s own changed files (ARCHITECTURE.md §20 M7): a
// real, organic 12-commit feature (introducing a Kafka producer/consumer
// event system, 23 real changed files) on a real repo triggered `pkr update
// --llm`, and not one of the 8 excerpt slots went to any of the 23 files
// that update was actually about — the selection heuristic re-ran a generic
// "orient a stranger to this whole repo" pass every time, blind to what the
// update's own inventory diff already knew changed. Zero of the 7 proposed
// nodes mentioned the feature the update was triggered by.
// ---------------------------------------------------------------------------
describe("synthesizeProductAndBehavior — excerpt priority for changed files (pkr update)", () => {
  /** README + entry point + 6 same-sized decoys exactly fill MAX_EXCERPT_FILES(8) via the size-fallback rule, same fixture shape as the grounding-tier tests above — guarantees a small "changed" file can only get in by being prioritized, not by winning on size. */
  function budgetFullFixtureRoot(): string {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "server.js"), "// entry point\n");
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(root, "src", `decoy${i}.js`), "// filler\n".repeat(50));
    }
    fs.writeFileSync(path.join(root, "src", "kafkaProducer.js"), "// small, but this is what actually changed\n");
    return root;
  }

  it("REGRESSION: a file the update's own diff knows changed gets excerpt priority, even under a full budget", async () => {
    const root = budgetFullFixtureRoot();
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const result = await synthesizeProductAndBehavior(
      root,
      inventory,
      [],
      "proj",
      "demo",
      null,
      allocator,
      noopLlm,
      [], // no existing inferred nodes
      ["src/kafkaProducer.js"], // changedFiles — this update's own diff
    );
    expect(result.excerptFiles).toContain("src/kafkaProducer.js");
  });

  it("without changedFiles (pkr export — nothing has 'changed' on a first export), the same small file loses to the size-based fallback", async () => {
    const root = budgetFullFixtureRoot();
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const result = await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, noopLlm);
    expect(result.excerptFiles).not.toContain("src/kafkaProducer.js");
  });

  it("ignores a changed-file path that isn't in the current inventory (e.g. since deleted) without erroring", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const result = await synthesizeProductAndBehavior(
      root,
      inventory,
      [],
      "proj",
      "demo",
      null,
      allocator,
      noopLlm,
      [],
      ["src/does-not-exist-anymore.js"],
    );
    expect(result.excerptFiles).toEqual(["README.md"]);
  });
});

// ---------------------------------------------------------------------------
// Evidence-grounding tiers (ARCHITECTURE.md §16 Run 3, third finding): a
// claimed evidence path must have actually been shown to the model — either
// as excerpt content (strong) or as another observed node's evidence pointer
// in the observed-facts summary (weaker, flagged). A path shown nowhere at
// all must be rejected outright — the pre-fix code accepted ANY real repo
// file, which is what let this gap go unnoticed.
// ---------------------------------------------------------------------------

/** Builds a repo where README.md + src/server.js consume most of the excerpt budget, and 6 same-sized decoys fill the rest — so `other.js` (small, real, cited only by an observed node) and `unknown.js` (real, cited nowhere) are both guaranteed to never become excerpts themselves. */
function groundingFixtureRoot(): string {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "server.js"), "// entry point\n");
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(root, "src", `decoy${i}.js`), "// filler\n".repeat(50));
  }
  fs.writeFileSync(path.join(root, "src", "other.js"), "// small, cited only via an observed node\n");
  fs.writeFileSync(path.join(root, "src", "unknown.js"), "// never referenced anywhere\n");
  return root;
}

function fakeLlmReturning(nodes: unknown[]): LlmClient {
  return {
    async complete() {
      return JSON.stringify({ nodes });
    },
  };
}

describe("synthesizeProductAndBehavior evidence-grounding tiers", () => {
  it("accepts evidence pointing at excerpt content without flagging it as weakly grounded", async () => {
    const root = groundingFixtureRoot();
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const llm = fakeLlmReturning([
      {
        type: "requirement",
        title: "Runs as an HTTP server",
        content: "The project boots an HTTP server as its entry point.",
        confidence: 0.7,
        domain: "CORE",
        evidence: [{ path: "src/server.js" }], // this path's content WAS shown (entry-point excerpt)
      },
    ]);
    const result = await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, llm);
    expect(result.nodes).toHaveLength(1);
    expect(result.weaklyGrounded).toHaveLength(0);
  });

  it("accepts but flags evidence that only ever appeared as another node's evidence pointer, never as content", async () => {
    const root = groundingFixtureRoot();
    const inventory = buildInventory(root);
    const idAllocator = IdAllocator.load(tmpDir());
    // A deterministic (observed) node whose evidence cites src/other.js — this
    // makes the path appear in the <observed_facts> summary text, but its
    // *content* is never part of <repository_excerpts> (component/convention
    // types are never pulled into excerpts by buildExcerpts' rule 3, which
    // only looks at api-endpoint/db-table types).
    const observed: KnowledgeNode = makeNode(idAllocator, "proj", "STRUCT", {
      type: "component",
      title: "src/other/",
      content: "A component the deterministic stage found.",
      status: "observed",
      confidence: null,
      evidence: [{ path: "src/other.js" }],
    });

    const synthAllocator = IdAllocator.load(tmpDir());
    const llm = fakeLlmReturning([
      {
        type: "domain-concept",
        title: "Other subsystem",
        content: "Inferred from the observed component fact about src/other.js.",
        confidence: 0.4,
        domain: "CORE",
        evidence: [{ path: "src/other.js" }], // real path, but content never shown
      },
    ]);
    const result = await synthesizeProductAndBehavior(root, inventory, [observed], "proj", "demo", null, synthAllocator, llm);

    expect(result.nodes).toHaveLength(1); // still accepted — the path is real and was legitimately referenced
    expect(result.excerptFiles).not.toContain("src/other.js"); // confirms this really is the weak-grounding case, not excerpt-backed
    expect(result.weaklyGrounded).toHaveLength(1);
    expect(result.weaklyGrounded[0].title).toBe("Other subsystem");
  });

  it("REGRESSION: rejects an evidence path that was never shown anywhere, even though it's a real file in the repo", async () => {
    const root = groundingFixtureRoot();
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const llm = fakeLlmReturning([
      {
        type: "domain-concept",
        title: "Unseen subsystem",
        content: "Claims to be grounded in a file the model was never shown.",
        confidence: 0.5,
        domain: "CORE",
        evidence: [{ path: "src/unknown.js" }], // real file, but never an excerpt AND never cited by any observed node
      },
    ]);
    const result = await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, llm);

    expect(result.nodes).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].title).toBe("Unseen subsystem");
  });
});

// ---------------------------------------------------------------------------
// `pkr update --llm` reconciliation (ARCHITECTURE.md §19, motivated by §16
// Run 4: a real call correctly proposed a *new*, corrected fact but never
// related it to the *old*, now-wrong one it was replacing).
// ---------------------------------------------------------------------------

/** Captures the exact prompt sent, and returns a scripted response — for asserting on what the model was shown, not just what came back. */
function capturingLlm(nodes: unknown[]): { llm: LlmClient; lastParams: () => LlmCompletionParams | null } {
  let last: LlmCompletionParams | null = null;
  return {
    llm: {
      async complete(params) {
        last = params;
        return JSON.stringify({ nodes });
      },
    },
    lastParams: () => last,
  };
}

describe("synthesizeProductAndBehavior reconciliation (existing_knowledge + supersedes)", () => {
  it("omits the <existing_knowledge> block entirely when there's nothing to reconcile against (pkr export)", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const { llm, lastParams } = capturingLlm([]);

    await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, llm); // existingInferredNodes omitted -> default []

    expect(lastParams()!.user).not.toContain("<existing_knowledge>");
  });

  it("includes existing inferred nodes (id, type, title, content) in <existing_knowledge> when present (pkr update)", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
    const inventory = buildInventory(root);
    const existingAllocator = IdAllocator.load(tmpDir());
    const existing = makeInferredNode(existingAllocator, "proj", "POINTS", {
      type: "business-rule",
      title: "VIP 2x multiplier applies only to purchase-earned points",
      content: "Accounts with lifetimeSpendCents >= $500 get a 2x multiplier.",
      confidence: 0.9,
      evidence: [{ path: "README.md" }],
    });

    const allocator = IdAllocator.load(tmpDir());
    const { llm, lastParams } = capturingLlm([]);
    await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, llm, [existing]);

    const shown = lastParams()!.user;
    expect(shown).toContain("<existing_knowledge>");
    expect(shown).toContain(existing.id);
    expect(shown).toContain("VIP 2x multiplier applies only to purchase-earned points");
    expect(shown).toContain("$500");
  });

  it("accepts a supersedes claim whose target ID was actually shown in <existing_knowledge>", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
    const inventory = buildInventory(root);
    const existingAllocator = IdAllocator.load(tmpDir());
    const existing = makeInferredNode(existingAllocator, "proj", "POINTS", {
      type: "business-rule",
      title: "VIP 2x multiplier applies only to purchase-earned points",
      content: "Accounts with lifetimeSpendCents >= $500 get a 2x multiplier.",
      confidence: 0.9,
      evidence: [{ path: "README.md" }],
    });

    const allocator = IdAllocator.load(tmpDir());
    const { llm } = capturingLlm([
      {
        type: "business-rule",
        title: "VIP 2x multiplier applies only to purchase-earned points",
        content: "Accounts with lifetime spend >= $1,000 get a 2x multiplier.",
        confidence: 0.85,
        domain: "POINTS",
        evidence: [{ path: "README.md" }],
        supersedes: [existing.id],
      },
    ]);
    const result = await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, llm, [existing]);

    expect(result.nodes).toHaveLength(1);
    expect(result.supersedesClaims).toEqual([{ nodeId: result.nodes[0].id, targets: [existing.id] }]);
    expect(result.nodes[0].supersedes).toBe(existing.id); // the schema's own singular field, set from the first verified target
  });

  it("REGRESSION: drops a supersedes target that was never shown in <existing_knowledge>, without rejecting the node itself", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const { llm } = capturingLlm([
      {
        type: "business-rule",
        title: "A brand new rule",
        content: "This rule claims to supersede something the model was never actually shown.",
        confidence: 0.7,
        domain: "POINTS",
        evidence: [{ path: "README.md" }],
        supersedes: ["RULE-NEVER-SHOWN-001"],
      },
    ]);
    // No existingInferredNodes passed -> "RULE-NEVER-SHOWN-001" was never in <existing_knowledge>.
    const result = await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, llm);

    expect(result.nodes).toHaveLength(1); // node itself still accepted — only the bad claim is dropped
    expect(result.nodes[0].supersedes).toBeNull();
    expect(result.supersedesClaims).toHaveLength(0);
  });
});

describe("synthesizeProductAndBehavior — architecture-overview (ARCHITECTURE.md §29)", () => {
  it("accepts a single, evidence-grounded architecture-overview node like any other type", async () => {
    const root = groundingFixtureRoot();
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const llm = fakeLlmReturning([
      {
        type: "architecture-overview",
        title: "System overview",
        content: "A single Node.js HTTP server handles all requests; no separate services.",
        confidence: 0.6,
        domain: "ARCHITECTURE",
        evidence: [{ path: "src/server.js" }],
      },
    ]);
    const result = await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, llm);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].type).toBe("architecture-overview");
    expect(result.skipped).toHaveLength(0);
  });

  it("REGRESSION: keeps only the first of two architecture-overview candidates, dropping the second even though the model was told at most one", async () => {
    const root = groundingFixtureRoot();
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const llm = fakeLlmReturning([
      {
        type: "architecture-overview",
        title: "System overview (first)",
        content: "First narrative.",
        confidence: 0.6,
        domain: "ARCHITECTURE",
        evidence: [{ path: "src/server.js" }],
      },
      {
        type: "architecture-overview",
        title: "System overview (second, extra)",
        content: "A second, redundant narrative the model shouldn't have proposed.",
        confidence: 0.6,
        domain: "ARCHITECTURE",
        evidence: [{ path: "src/server.js" }],
      },
    ]);
    const result = await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, llm);

    expect(result.nodes.filter((n) => n.type === "architecture-overview")).toHaveLength(1);
    expect(result.nodes[0].title).toBe("System overview (first)");
    expect(result.skipped).toEqual([
      { title: "System overview (second, extra)", reason: "only one architecture-overview node is kept per synthesis run — this one was extra" },
    ]);
  });

  it("architecture-overview still goes through the same evidence-verification as every other type", async () => {
    const root = groundingFixtureRoot();
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const llm = fakeLlmReturning([
      {
        type: "architecture-overview",
        title: "System overview",
        content: "Claims a path that was never shown to the model at all.",
        confidence: 0.6,
        domain: "ARCHITECTURE",
        evidence: [{ path: "src/totally-invented-path.js" }],
      },
    ]);
    const result = await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, llm);
    expect(result.nodes).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("no verifiable evidence path");
  });
});

describe("synthesizeProductAndBehavior — excerpt content is redacted before it reaches the LLM (ARCHITECTURE.md §31 security review)", () => {
  // Found via a deliberate adversarial review, not a fixture built to prove
  // a point after the fact: a real-shaped AWS access key embedded in an
  // entry point (exactly the kind of file buildExcerpts() prioritizes) was
  // confirmed present verbatim in the actual prompt string sent to
  // `LlmClient.complete()` before this fix — the secret write-gate
  // (secrets.ts) had only ever been wired into render.ts (what gets written
  // to .projectknowledge/), never into the one place repository content
  // leaves the machine entirely, as part of an Anthropic API call.
  it("REGRESSION: a real-shaped secret embedded in an excerpt file never reaches the LLM prompt", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "index.js"),
      "// TEMP: hardcoded during a debugging session, forgot to remove\nconst awsKey = \"AKIAIOSFODNN7EXAMPLE\";\nconst app = require('express')();\napp.listen(3000);\n",
    );
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const { llm, lastParams } = capturingLlm([]);

    const result = await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, llm);

    const sentPrompt = lastParams()!.user;
    expect(sentPrompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(sentPrompt).toContain("[REDACTED:AWS access key]"); // redacted, not silently dropped — the file's presence/shape is still visible
    expect(result.excerptRedactions).toBeGreaterThan(0);
  });

  it("reports zero excerpt redactions when nothing secret-shaped is present, not a false positive", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "README.md"), "# Demo\nJust an ordinary project.\n");
    const inventory = buildInventory(root);
    const allocator = IdAllocator.load(tmpDir());
    const { llm } = capturingLlm([]);

    const result = await synthesizeProductAndBehavior(root, inventory, [], "proj", "demo", null, allocator, llm);
    expect(result.excerptRedactions).toBe(0);
  });
});
