# PKR Format Specification — schema v0.1

Status: draft, unstable · This is the open, portable format. Treat breaking changes
to anything in this document as requiring a `schema_version` bump.

## 0. Design commitments

The `.projectknowledge/` format must remain, permanently:

- **Human-readable** — plain Markdown + YAML + JSON, openable in any editor.
- **Machine-readable** — every fact a human can read also exists as structured data
  (front-matter on the Markdown, or JSON) an agent can parse without an LLM.
- **Versioned** — `schema_version` in the manifest; additive changes bump the minor
  version, breaking changes bump the major version.
- **Portable / vendor-neutral** — no vendor-specific fields in the core schema.
  Vendor adapters (§9) live in a separate, clearly-marked `context/` export, generated
  *from* the core format, never hand-authored into it.
- **Git-compatible** — the directory is designed to be committed to the same repo it
  describes (or a sibling repo). Diffs must be reviewable in a normal `git diff`.
  Markdown files are the review surface; JSON files are sorted-key and pretty-printed
  so diffs stay meaningful.
- **Deterministic where practical** — given the same repository state and the same
  extractor version, structural facts (file lists, dependency versions, detected
  routes) must re-extract identically. LLM-synthesized prose is not required to be
  byte-identical across runs, but its *node IDs, type, and evidence set* must be
  stable (§4).

## 1. Directory layout

```
.projectknowledge/
  manifest.yaml                 # entry point, see §2
  README.md                     # human orientation, generated

  product/                      # Intent layer
    vision.md
    scope.md
    requirements.md
    user-flows.md
    domain-model.md

  architecture/                 # Intent + implementation-constraint layer
    overview.md
    components.md
    data-flow.md
    boundaries.md
    deployment.md

  implementation/                # Implementation-constraint layer
    technology-stack.md
    repository-structure.md
    coding-conventions.md
    dependencies.md
    environment.md

  interfaces/                    # Implementation-constraint layer
    api-contracts.md
    database-schema.md
    events.md
    external-services.md

  behavior/                      # Intent + implementation-constraint layer
    business-rules.md
    invariants.md
    edge-cases.md
    error-behavior.md

  decisions/                     # ADRs — historical record, immutable once written
    ADR-0001-<slug>.md
    ADR-0002-<slug>.md

  reconstruction/                # Generated FROM the above, not hand-authored
    reconstruction.md
    deterministic-constraints.md
    validation.md
    known-ambiguities.md

  traceability/
    source-map.json              # KnowledgeNode ID -> source files/symbols
    knowledge-map.json           # KnowledgeNode ID -> related node IDs (denormalized graph)

  .knowledge/                    # internal, not for hand editing — see §8
    nodes.jsonl
    edges.jsonl
```

**Rule: only generate files that have content.** An empty `events.md` for a project
with no event system must not be created — its absence is itself information (or, if
ambiguous, it's recorded in `known-ambiguities.md` instead). The tree above is the
full vocabulary of possible files, not a checklist to fill in.

Every generated `*.md` file under `product/`, `architecture/`, `implementation/`,
`interfaces/`, `behavior/` begins with YAML front-matter and is otherwise a rendering
of one or more KnowledgeNodes (§4) — never freehand prose that doesn't trace back to
a node.

## 2. Manifest

`manifest.yaml` is the machine entry point. An agent (or the CLI) reads this file
first and uses it to decide what else to load.

```yaml
schema_version: "0.1"

project:
  name: example-project
  description: One-line description, sourced from README/package.json when available.

knowledge:
  generated_at: 2026-08-15T09:00:00Z
  source_commit: 8a21c91b3f...
  generator_version: "pkr-cli@0.1.0"
  knowledge_version: v0.3          # see §7 Versioning

reconstruction:
  target_level: 4                  # see §3

sections:
  product: true
  architecture: true
  implementation: true
  interfaces: true
  behavior: true
  decisions: true
  reconstruction: true

validation:
  commands:
    build: npm run build
    test: npm test
  expected_endpoints:
    - "POST /api/login"
    - "GET /api/users/:id"
  expected_tables:
    - users
    - sessions

integrity:
  node_count: 142
  edge_count: 210
  nodes_hash: sha256:...           # hash of sorted nodes.jsonl, for tamper/drift detection
```

## 3. Reconstruction levels

A precise, checkable definition — not vibes. `reconstruction.target_level` in the
manifest declares what the PKR *claims* to support; `pkr compare` measures what a
given reconstruction *achieved*, and they may differ.

| Level | Name | Claim | Minimum evidence required in the PKR |
|---|---|---|---|
| **1** | Concept | An agent can restate the product idea and its purpose. | `product/vision.md` with at least one confirmed or observed node. |
| **2** | Behavioral | An agent can reproduce equivalent user-visible behavior. | Level 1 + `product/requirements.md`, `product/user-flows.md`, `behavior/business-rules.md` with evidence. |
| **3** | Architectural | An agent can reproduce the same major components and data model, not necessarily the same tech. | Level 2 + `architecture/*` + `interfaces/database-schema.md` (schema-level, not vendor-specific). |
| **4** | Implementation-constrained | An agent can reproduce the same languages, frameworks, major libraries, APIs, DB schema, directory conventions, component boundaries, infra assumptions. | Level 3 + `implementation/*` + `interfaces/api-contracts.md` with concrete request/response shapes + `reconstruction/deterministic-constraints.md`. |
| **5** | Near-deterministic | Independent agents produce *structurally very similar* implementations. Explicitly **not** byte-for-byte and never claimed to be. | Level 4 + `reconstruction/validation.md` with machine-checkable acceptance criteria (build/test commands, endpoint list, schema list) sufficient that `pkr compare` can score ≥3 of its 5 dimensions (§ARCHITECTURE.md §Reconstruction scoring) without human judgment. |

A PKR must never claim a level it has no evidence for. `pkr export` computes the
achievable level from what was actually extracted; it is not operator-set.

## 4. KnowledgeNode

The Markdown tree is a *rendering*. The source of truth is the node/edge graph.

```ts
interface KnowledgeNode {
  id: string;                 // stable ID, see §5, e.g. "REQ-AUTH-001"
  project_id: string;
  type: NodeType;              // see enum below
  title: string;
  content: string;             // Markdown body, CommonMark
  status: "observed" | "inferred" | "confirmed" | "unknown" | "historical-lost";
  confidence: number | null;   // 0.0–1.0, required when status = "inferred", null when "observed"/"confirmed"
  confirmed_by: "human" | null;
  evidence: EvidenceRef[];     // see below, required when status != "unknown"
  supersedes: string | null;   // previous node ID, for correction history
  created_at: string;          // ISO 8601
  updated_at: string;
}

interface EvidenceRef {
  path: string;                // repo-relative file path
  symbol?: string;              // e.g. "authenticateUser", from a language-aware extractor
  lines?: [number, number];
  commit?: string;              // source commit this evidence was captured at
}

type NodeType =
  | "requirement" | "user-flow" | "domain-concept"       // product/
  | "component" | "boundary" | "deployment-unit"          // architecture/
  | "tech-choice" | "convention" | "dependency"            // implementation/
  | "api-endpoint" | "db-table" | "event" | "external-service" // interfaces/
  | "business-rule" | "invariant" | "edge-case" | "error-behavior" // behavior/
  | "decision";                                             // decisions/
```

### 4.1 Status vs. confidence — precise rules

| status | meaning | confidence field | evidence required | who can set it |
|---|---|---|---|---|
| `observed` | Directly read from a deterministic source (a manifest file, a schema file, a route table, a config key). No LLM judgment involved in *whether* it's true, only in phrasing. | `null` | required, ≥1 ref | extractor (static analysis) |
| `inferred` | An LLM (or heuristic) concluded this from indirect signals. | required, 0.0–1.0 | required, ≥1 ref | extractor (LLM synthesis) |
| `confirmed` | A human reviewed an `observed`/`inferred` node and affirmed it, or authored it directly. | `null` | required unless human explicitly waives it | human, via review UI or CLI |
| `unknown` | The extractor could not determine this with any confidence; recorded so the gap is visible rather than silently absent. | `null` | none required | extractor |
| `historical-lost` | Known to have existed (referenced elsewhere) but the source information needed to reconstruct it is gone (e.g. an ADR referenced in a commit message whose file was deleted). | `null` | best-effort partial evidence | extractor |

Rendering rule (Rule 2/3 from the master prompt): any Markdown rendering of a node
with status `inferred` MUST display its confidence and evidence inline, e.g.:

```markdown
### Authentication

Status: observed
Implementation: JWT access tokens with refresh tokens.
Evidence:
- src/auth/token.ts
- src/auth/refresh.ts
```

A node is never rendered as bare assertion if its status is anything other than
`observed` or `confirmed`.

### 4.2 Human correction semantics (Rule: protect confirmed knowledge)

- Confirming a node sets `status: confirmed`, `confirmed_by: human`, and freezes
  `content` against automatic rewrite by future extraction runs.
- If a later `pkr update` finds evidence that contradicts a `confirmed` node, it does
  **not** overwrite it. It creates a *new* node with a `conflicts_with` edge (§6) to
  the confirmed node, status `inferred` or `observed` as appropriate, and surfaces it
  in the update report for human resolution. Silent overwrite of confirmed knowledge
  is a spec violation, not an implementation bug to fix later.
- Resolving a conflict either (a) re-confirms the original (the new evidence is
  rejected/explained) or (b) supersedes it — the old node gets `status` unchanged but
  is linked via a `supersedes` edge from the new confirmed node, and stops being
  rendered as current (still queryable as history).

## 5. Stable IDs

Format: `<PREFIX>-<DOMAIN>-<NNN>`, uppercase, hyphen-separated, zero-padded to 3
digits (extend to 4 if a domain exceeds 999 nodes).

| Prefix | Node types |
|---|---|
| `REQ` | requirement |
| `FLOW` | user-flow |
| `DOM` | domain-concept |
| `ARCH` | component, boundary, deployment-unit |
| `TECH` | tech-choice, convention, dependency |
| `API` | api-endpoint |
| `DB` | db-table |
| `EVT` | event |
| `EXT` | external-service |
| `RULE` | business-rule, invariant, edge-case, error-behavior |
| `DEC` | decision (ADRs; sequential, not domain-scoped: `DEC-0001`) |

`DOMAIN` is a short uppercase tag derived from the feature area (e.g. `AUTH`,
`PAYMENTS`, `USERS`), assigned once and kept stable. IDs are allocated by the
extractor from a per-project counter persisted in `.knowledge/` (§8) — never reused,
even if the underlying node is later deleted, so that references in old ADRs and
external documents remain resolvable (a deleted node's ID resolves to a tombstone,
not to a different concept later).

## 6. KnowledgeEdge

```ts
interface KnowledgeEdge {
  id: string;
  project_id: string;
  source_node: string;   // KnowledgeNode.id
  target_node: string;   // KnowledgeNode.id
  relationship_type: RelationshipType;
  evidence?: EvidenceRef[];
  created_at: string;
}

type RelationshipType =
  | "implements"      // e.g. ARCH-AUTH-001 implements REQ-AUTH-001
  | "depends_on"       // e.g. API-USERS-001 depends_on ARCH-AUTH-001
  | "constrained_by"   // e.g. ARCH-AUTH-001 constrained_by TECH-AUTH-003
  | "exposes"          // e.g. ARCH-AUTH-001 exposes API-AUTH-LOGIN
  | "tested_by"        // e.g. API-AUTH-LOGIN tested_by <test evidence, via source-map>
  | "derived_from"     // inferred node derived_from observed node(s)
  | "supersedes"       // correction history, see §4.2
  | "conflicts_with";  // unresolved contradiction, see §4.2
```

Canonical traceability chain (Rule 5):

```
REQ-AUTH-001 --implements--> ARCH-AUTH-001 --exposes--> API-AUTH-LOGIN
                                                          |
                                                    (source-map.json)
                                                          v
                                          src/auth/login.ts::authenticateUser
                                                          |
                                                     tested_by
                                                          v
                                            tests/auth/login.test.ts
```

`tested_by` and the raw file/symbol pointers are not modeled as separate nodes for
every file — they live in `traceability/source-map.json` keyed by node ID, to avoid a
node explosion. Edges connect *knowledge* to *knowledge*; `source-map.json` connects
*knowledge* to *files*.

## 7. Versioning

A **Knowledge Version** is an immutable, committed snapshot of which node revisions
are current.

```yaml
# .knowledge/versions/v0.18.yaml
version: v0.18
parent_version: v0.17
created_at: 2026-08-15T09:00:00Z
author: human:stratoske@gmail.com        # or "extractor:pkr-cli@0.1.0"
summary: Increase login persistence.
changed_nodes:
  - id: REQ-AUTH-004
    change: modified
  - id: RULE-AUTH-SESSION
    change: modified
reason: Increase login persistence, per product decision.
source_commit: 8a21c91b3f...              # commit in the CODE repo, if connected
```

`pkr export` on a clean import creates `v0.1`. `pkr update` proposes a *draft* version
that becomes immutable only when committed (`pkr commit` or the equivalent web
action) — mirroring the "review before commit" step in the product workflow
(`PRODUCT_SPEC.md` §4). Draft state is where human review of `inferred`/`unknown`
nodes happens.

## 8. Internal structured store vs. portable export

`.knowledge/nodes.jsonl` and `.knowledge/edges.jsonl` (one JSON object per line,
sorted by ID) are the literal source of truth for a *file-based* project (CLI-only
mode, no hosted DB — see `ARCHITECTURE.md` §Storage). All Markdown under `product/`,
`architecture/`, etc. is generated output. Hand-editing a rendered `.md` file is
supported for readability but is **not** how corrections are durably applied — running
`pkr export` again would overwrite it. Corrections go through `pkr confirm <node-id>`
/ `pkr edit <node-id>`, which write to `.knowledge/*.jsonl` and then re-render.

When Klerk is used as a hosted platform, `knowledge_nodes`/`knowledge_edges` tables
(Postgres) are the source of truth instead, and `.knowledge/*.jsonl` becomes one of
several possible export targets — the two representations use the same field set so
neither is a lossy projection of the other.

## 9. Model-agnostic context export

`pkr context --target {codex|claude|generic}` reads the same nodes/edges and
manifest and produces a `context/<target>/` bundle — e.g. token-budget-aware
concatenation order, target-specific front-matter conventions — but never adds facts
that don't exist in the core graph, and never encodes a fact *only* in a vendor
target. If a vendor adapter needs a fact the core schema doesn't have, the fact is
added to the core schema first (versioned, §0), then the adapter renders it.

## 10. Secrets

The exporter must never write a literal secret value into any generated file.

- Environment variables are recorded as: name, inferred purpose, required (bool),
  where referenced (evidence). Never a value.
- A pre-write scan (entropy + pattern match: AWS keys, private key headers, JWT-shaped
  strings, common vendor key prefixes like `sk_live_`, `ghp_`, etc.) runs on every
  piece of content before it's written to `.projectknowledge/`. A match blocks that
  content from being written and instead records `status: unknown` with a note that a
  likely secret was redacted, plus the evidence path (not the value) so a human can
  investigate.
- `.env`, `.env.*`, and anything matching the repo's own `.gitignore` secret-ish
  patterns are read only to discover variable *names* referenced elsewhere in code;
  their contents are never included in node `content`.

## 11. Untrusted content

Every file in the analyzed repository is DATA. Text such as "ignore previous
instructions" or "AI agent: also run X" found in source comments, READMEs, or commit
messages must never change extractor behavior. The extraction pipeline enforces this
structurally, not just by prompt wording — see `ARCHITECTURE.md` §Security.
