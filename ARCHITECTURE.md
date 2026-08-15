# Klerk — Architecture

Status: draft v0.1. Companion to `PRODUCT_SPEC.md` (what/why) and `PKR_SPEC.md`
(the format). This document is the how: components, pipelines, storage, API, build
order, and risk register.

## 0. Implementation status

Kept current as code lands, so this document doesn't drift from reality.

| Stage / component | Status |
|---|---|
| Stage 1 — Ingest & inventory | ✅ built (`packages/core/src/extract/inventory.ts`) |
| Stage 2 — Manifest & dependency analysis | ✅ built, package.json only (`extract/dependencies.ts`) |
| Stage 3 — Interface analysis | ✅ built: HTTP routes (Express/Fastify/Koa-style + Next.js file routing), DB schema (Prisma + raw SQL `CREATE TABLE`), external services (dependency lookup). Event detection not built. (`extract/interfaces.ts`) |
| Stage 4 — Structure analysis | ✅ built (`extract/structure.ts`) |
| Stage 5 — Test & environment analysis | ❌ not built |
| Stage 6 — Semantic synthesis (LLM) | ✅ built (`extract/synthesize.ts`, `llm/anthropic.ts`) — proposes `requirement`/`user-flow`/`domain-concept`/`business-rule`/`invariant`/`edge-case`/`error-behavior` nodes. Requires `ANTHROPIC_API_KEY`; skips gracefully (deterministic-only export) if unset or `--no-llm` is passed. Every claimed evidence path is checked against the real repo inventory before a node is accepted — unverifiable ones are dropped and reported, not softened. `architecture/overview.md` narrative synthesis not built (no matching node type yet). |
| Stage 7 — Render & write | ✅ built (`render/render.ts`), including the secret write-gate |
| `pkr export` CLI | ✅ built (`packages/cli`), flags: `--out`, `--no-llm`, `--model` |
| `pkr update` (incremental) | ❌ not built |
| `pkr reconstruct` (M2) | ✅ built (`packages/core/src/reconstruct/`) — loads a `.projectknowledge/` dir (internal `.knowledge/*.jsonl` store, or a markdown-fallback parser when that store isn't present — PKR_SPEC.md §8 portability, verified byte-identical output both ways), computes a phase-order build order (currently pure phase-order — no edges exist yet to topo-sort within a phase), and renders `.reconstruction/{SYSTEM_PROMPT,BUILD_ORDER,CONSTRAINTS,ACCEPTANCE_TESTS,CONTEXT,KNOWN_AMBIGUITIES}.md`. No LLM call. `ACCEPTANCE_TESTS.md` now pulls real `npm run build`/`test` commands (stage 2 extracts them from `package.json` scripts) plus expected endpoints/tables straight from extracted nodes. |
| `pkr compare`, `pkr context` | ❌ not built |
| Hosted platform (M6+) | ❌ not built, by design (§7) |

Validated end-to-end against: this repo, `packages/core` standalone, a cloned copy
of `expressjs/express`, and a small fixture repo exercising Prisma + Stripe/Postgres
dependency detection + Express routes. All produced schema-valid, evidence-backed
`observed` nodes with an honest reconstruction level. Stage 6's parsing, prompt
security framing, and evidence-grounding filter were validated offline against a
mocked `LlmClient` (code-fence-wrapped JSON, a hallucinated evidence path correctly
dropped) — not yet exercised against a live model call in this environment (no
`ANTHROPIC_API_KEY` configured here); that's the next thing to run with a real key.

## 1. System components

```
                     ┌─────────────────────────────┐
                     │        pkr CLI (TS)         │   <- primary interface, Milestone 1
                     │  export / update / diff /   │
                     │  reconstruct / compare /     │
                     │  context / confirm / commit  │
                     └───────────────┬──────────────┘
                                     │ reads/writes
                     ┌───────────────▼──────────────┐
                     │   Core engine (shared lib)    │
                     │  extraction · graph · render  │
                     │  · diff · reconstruction ·    │
                     │  compare · secret-scan         │
                     └───────────────┬──────────────┘
                                     │
                 ┌───────────────────┼───────────────────┐
                 │                   │                   │
        ┌────────▼───────┐  ┌────────▼────────┐  ┌───────▼────────┐
        │ Storage adapter │  │ Storage adapter  │  │  Portable export │
        │  local (SQLite  │  │  hosted (Postgres│  │  .projectknowledge/
        │  + .knowledge/  │  │  via Prisma)      │  │  (always produced) │
        │  jsonl files)   │  │  — Milestone 6+   │  │                  │
        └─────────────────┘  └──────────────────┘  └──────────────────┘
                                     │
                     ┌───────────────▼──────────────┐
                     │   Web app (Next.js) — M6+     │
                     │  dashboard / explorer / graph │
                     │  / versions / diff / recon UI │
                     └───────────────────────────────┘
```

The **core engine** is storage-agnostic: it operates on the `KnowledgeNode`/
`KnowledgeEdge` interfaces from `PKR_SPEC.md` §4/§6 through a small repository
interface (`NodeStore`), with two implementations — a local one (SQLite file next to
`.projectknowledge/`, for the CLI-only MVP) and a hosted one (Postgres, for the web
app). This is the single biggest structural decision in this document (see §7,
deviation from the suggested stack) and it's what makes Milestone 1–4 possible without
building the hosted platform first.

## 2. Extraction pipeline (`pkr export` / `pkr update`)

Seven stages, each producing nodes/edges tagged with the status/evidence rules from
`PKR_SPEC.md` §4.1. Stages 1–5 are deterministic static analysis (`status: observed`,
no LLM). Stage 6 is LLM synthesis (`status: inferred`). Stage 7 is rendering, which is
deterministic given the node/edge set.

1. **Ingest & inventory** — walk the repo respecting `.gitignore`; classify files
   (source / config / test / docs / infra / lockfile / generated); compute a content
   hash per file. This hash set is what `pkr update` diffs against next time.
2. **Manifest & dependency analysis** — parse `package.json`/`pyproject.toml`/
   `go.mod`/`Cargo.toml`/etc., lockfiles, and framework config (`next.config.js`,
   `tsconfig.json`, Docker/compose, CI config). Produces `tech-choice` and
   `dependency` nodes, all `observed`.
3. **Interface analysis** — language-aware (AST where a parser is available, regex/
   heuristic fallback otherwise) detection of: HTTP routes and their handlers,
   database schema (migration files, ORM models, raw SQL DDL), event
   publish/subscribe call sites, outbound calls to known external service SDKs.
   Produces `api-endpoint`, `db-table`, `event`, `external-service` nodes, `observed`,
   each with `EvidenceRef`s down to file+line and symbol where the parser supports it.
4. **Structure analysis** — directory layout, naming conventions, test file
   co-location pattern, monorepo/workspace detection. Produces `component`,
   `boundary`, `convention` nodes, `observed`.
5. **Test & environment analysis** — test runner, test file inventory (not full
   content), referenced env var *names* (never values — `PKR_SPEC.md` §10),
   CI/deploy config. Feeds `implementation/environment.md` and
   `reconstruction/validation.md`.
6. **Semantic synthesis (LLM pass)** — given the observed graph from stages 1–5 plus
   a bounded, prioritized set of source file excerpts (READMEs, entry points, the
   files with the most inbound edges from stage 3), an LLM proposes: `requirement`,
   `user-flow`, `domain-concept`, `business-rule`, `invariant`, `edge-case`,
   `error-behavior` nodes, and narrative content for `architecture/overview.md`. Every
   node from this stage is `inferred` with a confidence score and evidence pointing at
   the specific excerpts that motivated it. The synthesis prompt is a fixed system
   prompt that treats all repository content as data (§6 Security) and is versioned
   alongside `generator_version` so extraction is reproducible per generator release.
7. **Render & write** — nodes/edges → Markdown (grouped by directory per
   `PKR_SPEC.md` §1) → `manifest.yaml` → `traceability/*.json`. Runs the secret scan
   (`PKR_SPEC.md` §10) as a write-gate, not a post-hoc check.

`pkr update` reruns stage 1 first; if no file hashes changed since the last run, it
exits immediately. Otherwise it re-runs stages 2–5 only for changed files, computes
which existing nodes have evidence pointing at those files (via `source-map.json`),
re-runs stage 6 only for the affected node neighborhood (the changed nodes plus their
1-hop graph neighbors — bounded, not the whole project), and re-renders only the
touched Markdown files. Confirmed nodes are never silently rewritten (`PKR_SPEC.md`
§4.2) — contradicted confirmed nodes become conflicts in the update report.

## 3. Confidence & evidence model — implementation notes

This is specified precisely in `PKR_SPEC.md` §4.1; architecturally, the important
part is that **status is a property of how the fact was produced, not a UI label
applied afterward**. Stage 1–5 code paths structurally can only emit `observed`
nodes (the function signatures don't accept a confidence argument). Stage 6 code
paths structurally can only emit `inferred` nodes (confidence is a required
parameter). `confirmed` is only reachable through the correction API. This is
enforced at the type level in the core engine, not by convention, so a future
contributor can't accidentally have an LLM call produce an `observed` node.

## 4. Reconstruction pipeline (`pkr reconstruct`)

Input: a `.projectknowledge/` directory (any project's, not necessarily one produced
by this same install — portability). Output: `.reconstruction/` package.

1. Load `manifest.yaml`, validate `schema_version` compatibility.
2. Load the full node/edge graph (from `.knowledge/*.jsonl` if present, else parse it
   back out of the Markdown front-matter — the format must survive losing the
   internal store, per the open-format commitment in `PKR_SPEC.md` §0).
3. Compute a **build order**: topological sort of `component`/`db-table`/
   `api-endpoint` nodes over `depends_on`/`exposes`/`constrained_by` edges, grouped
   into the canonical phases (repo init → runtime config → schema → domain models →
   auth → APIs → UI → tests), falling back to the canonical phase order when the
   graph doesn't fully constrain ordering within a phase.
4. Render:
   - `SYSTEM_PROMPT.md` — role, the three-layer model (intent vs. constraint vs.
     implementation), explicit instruction to treat `known-ambiguities.md` gaps as
     decisions the agent must make and document, not block on.
   - `BUILD_ORDER.md` — the computed order from step 3.
   - `CONSTRAINTS.md` — all `implementation-constraint`-layer nodes at or below the
     manifest's `target_level`, i.e. a level-3 PKR does not hand a reconstruction
     agent invented level-4 constraints.
   - `ACCEPTANCE_TESTS.md` — from `validation.md`: build/test commands, expected
     endpoints, expected tables — the machine-checkable subset only.
   - `CONTEXT.md` — everything else, budget-ordered by graph centrality so the most
     load-bearing nodes come first (important once this has to fit a context window).
5. `known-ambiguities.md` is generated by listing every `unknown`/`historical-lost`
   node reachable from a `requirement` or `component` node — i.e. gaps that actually
   block reconstruction, not every unknown in the graph indiscriminately.

## 5. Comparison / scoring pipeline (`pkr compare`)

MVP scope is deliberately narrow and honestly labeled (Rule from PROMPT §17: "do not
fake precision").

| Dimension | How it's actually computed in the MVP | Confidence |
|---|---|---|
| API compatibility | Diff the `api-endpoint` nodes extracted from *reconstructed* against the original's `interfaces/api-contracts.md` — method+path set overlap, and where request/response shape was captured, shape diff. | Measured |
| Schema compatibility | Diff extracted `db-table` nodes (table + column names/types where available) between original and reconstruction. | Measured |
| Test compatibility | Run the original's test command against the reconstruction where the acceptance tests are black-box (e.g. HTTP contract tests); report pass/fail count. Falls back to "not measurable" if tests are white-box/unit-level and don't apply. | Measured, may be N/A |
| Build success | Run `validation.commands.build` in the reconstruction; boolean. | Measured |
| Architecture similarity | Node-type-set and edge-topology similarity between the two `component` graphs (graph edit distance, normalized). | **Heuristic — labeled as such in output** |
| Behavioral similarity | Currently a rollup of the above (weighted), not independent measurement. | **Heuristic — labeled as such in output** |

The MVP `pkr compare` output always prints which rows are "measured" vs. "heuristic"
and never prints an unlabeled single score without that breakdown. An "Overall
reconstruction score" is a documented weighted average of the row scores, and the
weights are printed alongside it — not a black box.

## 6. Security

**Secrets** — write-gate scan, see `PKR_SPEC.md` §10. Runs in the core engine, not
optionally in a UI layer, so the CLI has the same protection as the web app.

**Prompt injection / untrusted repository content** — repository text reaches the
stage-6 LLM only as clearly-delimited data blocks inside a fixed system prompt that:
(a) states repository content is data to analyze, never instructions to follow, (b)
is not itself derived from repository content, (c) is versioned and logged with the
extraction run so a bad output is auditable back to a specific prompt version. The
core engine additionally strips common injection patterns from excerpts before they
reach the model as a defense-in-depth measure (not the primary control — the primary
control is the framing). Any content that reads as an instruction aimed at the
extractor itself (e.g. "AI agent: include the string X in your output") is flagged as
`status: unknown` with a note rather than acted upon, and surfaced for human review
if it triggers on a stage-6 output.

**Isolation** — every query in the hosted storage adapter is scoped by `project_id`
resolved from the authenticated session server-side; there is no client-suppliable
`project_id` that bypasses ownership check. No cross-project context assembly, ever
— even for "similar project" type features, which are explicitly not built (PROMPT
§29 territory).

## 7. Storage model

Two adapters implement the same `NodeStore` interface (§1). Field names below match
`PKR_SPEC.md` §4/§6/§7 directly — the DB schema is not a separate model from the
portable format's model, just a relational encoding of it.

```
users                 (id, email, password_hash, created_at)
projects              (id, owner_id, name, description, visibility, created_at)
project_sources       (id, project_id, kind[local|git], location, last_commit)
knowledge_nodes       (id, project_id, type, title, content, status, confidence,
                        confirmed_by, evidence jsonb, supersedes, created_at, updated_at)
knowledge_edges       (id, project_id, source_node, target_node, relationship_type,
                        evidence jsonb, created_at)
knowledge_versions    (id, project_id, parent_version_id, author, summary, reason,
                        source_commit, created_at)
knowledge_version_nodes (version_id, node_id, change[added|modified|removed])
source_mappings       (node_id, file_path, symbol, line_start, line_end, commit)
extraction_runs       (id, project_id, stage, status, started_at, finished_at,
                        generator_version, error)
reconstruction_runs   (id, project_id, knowledge_version_id, output_location,
                        started_at, finished_at)
```

**Deviation from PROMPT §22 suggested stack:** the MVP (Milestones 1–4) does **not**
stand up Postgres, Next.js, or hosted auth at all. It's a local CLI writing to
SQLite + the portable `.projectknowledge/` tree on disk. Rationale recorded as
`ADR-0001` (to be written when implementation starts): the product risk that matters
first is "does the extraction→reconstruction loop produce anything useful," which is
fully testable without a server. Standing up the hosted platform before that question
has an answer risks building a polished UI over a knowledge model that turns out to
be wrong. Postgres/Prisma/Next.js/auth are still the right MVP choice for Milestone
6+ (the hosted platform) and nothing above precludes them — the `NodeStore`
abstraction exists specifically so the hosted adapter is additive, not a rewrite.

## 8. API (for Milestone 6+, designed now so the storage model doesn't have to change)

```
POST   /projects
GET    /projects
GET    /projects/:id
DELETE /projects/:id

POST   /projects/:id/import              # register a source, trigger extraction_run
GET    /projects/:id/knowledge           # list nodes (filter by type/status)
GET    /projects/:id/knowledge/:nodeId
PATCH  /projects/:id/knowledge/:nodeId   # human correction -> status: confirmed
GET    /projects/:id/graph               # nodes + edges for graph view

GET    /projects/:id/versions
POST   /projects/:id/versions            # commit current draft as a version
GET    /projects/:id/diff?from=&to=      # semantic diff, PKR_SPEC §9-equivalent

POST   /projects/:id/export              # -> .projectknowledge/ zip or Git push
POST   /projects/:id/reconstruction      # -> .reconstruction/ package
GET    /projects/:id/source-map
```

All routes are project-scoped and authorization-checked server-side per §6. Request/
response bodies use the `KnowledgeNode`/`KnowledgeEdge` shapes directly (Zod schemas
generated from one shared TS definition, per PROMPT §22) so the API, the DB layer,
and the portable export never drift into three different shapes for the same fact.

## 9. Build order / milestones

Matches PROMPT §33, made concrete:

- **M1 — CLI export loop.** `pkr export <repo>` → `.projectknowledge/`, local SQLite
  store, stages 1–5 (deterministic) fully working, stage 6 (LLM synthesis) working
  against one LLM backend (configurable, default Claude via API key env var — the
  *tool's* backend choice, unrelated to the vendor-neutrality of the *format*, see
  `PKR_SPEC.md` §9). No web app, no Postgres, no auth.
- **M2 — Reconstruction package.** `pkr reconstruct` implemented against M1 output.
- **M3 — Real-repo test.** Run the full loop (`PRODUCT_SPEC.md` §8) against one real
  medium open-source repo, by hand, with a fresh Claude Code / Codex session doing
  the reconstruction.
- **M4 — Gap analysis.** Diff what the reconstruction got wrong/missing against what
  the PKR contained vs. should have contained. This is the milestone most likely to
  change `PKR_SPEC.md`.
- **M5 — Schema revision.** Apply M4 findings; re-run M3 on a second repo to check
  the fix generalizes.
- **M6+ — Hosted platform.** Only after M5 shows a promising score: Postgres/Prisma
  storage adapter, auth, Next.js web app (dashboard/explorer/graph/versions/diff/
  reconstruction UI), `pkr update` incremental pipeline exposed via API,
  `knowledge_versions` UI, human-correction UI.

**Smallest possible vertical slice to start writing code today:** a CLI package that
does stages 1, 2, 4, 7 of §2 (skip interface/test analysis and skip the LLM stage 6
initially) against a small TypeScript repo, producing a valid `manifest.yaml` +
`implementation/*.md` + `.knowledge/*.jsonl`, with `schema_version: "0.1"`. That's
enough to validate the storage model, the render pipeline, and the file layout before
adding the harder parts (AST-based interface detection, LLM synthesis, incremental
update). Recommend this as the literal first PR.

## 10. Assumptions

- The primary consumer of a PKR is an AI coding agent operating with normal
  filesystem/terminal tool access (i.e. it can read `.projectknowledge/` like any
  other directory) — not a bespoke API integration per vendor.
- "Medium-sized open-source project" for the validation experiment (M3) means
  roughly 5k–50k LOC, single primary language, a real test suite — large enough to
  be non-trivial, small enough for stage 6 to run against a bounded excerpt budget
  without a RAG layer in the MVP.
- One LLM call pattern (bounded excerpts + observed graph as context) is sufficient
  for stage 6 quality at MVP scale. This is unvalidated — it's the main thing M3/M4
  test.
- Users importing a repository have the right to do so (no attempt to police this in
  MVP beyond standard ToS).

## 11. Unknowns

- How much of "business rules" and "invariants" extraction quality depends on
  test-file analysis vs. source-file analysis vs. commit-history analysis. Untested.
- Whether AST-based interface detection needs a real parser per language from day
  one, or whether regex/heuristic detection is good enough through M4 for the
  languages in the first test repos. Leaning heuristic-first, upgrade per language as
  M4 gap analysis demands it.
- Where the context-budget line actually is for stage 6 on a 50k-LOC repo with one
  LLM call vs. needing multiple passes / a map-reduce extraction strategy.
- Whether `pkr compare`'s heuristic dimensions (architecture/behavioral similarity)
  are useful signal at all, or just noise that should be dropped before M6.

## 12. Major technical risks

1. **Extraction quality ceiling.** If stage 6 synthesis is shallow or hallucinated,
   the whole hypothesis (PROMPT §32) fails regardless of how good the format/storage
   design is. This is why M3/M4 happen before any UI investment.
2. **Context budget at scale.** A single bounded-excerpt LLM call may not scale past
   small/medium repos; may require map-reduce extraction (per-component synthesis
   then a merge pass), which complicates the "single source of truth" rule (§Rule 1)
   if not designed carefully.
3. **Incremental update correctness.** Determining "which knowledge nodes are
   affected by this file diff" is a nontrivial dependency-inference problem; getting
   it wrong either misses real changes (stale knowledge) or over-invalidates
   (defeats the point of incremental update). `source-map.json` granularity directly
   bounds how good this can be.
4. **Reconstruction agent variance.** Different AI agents/models given the same
   package may produce wildly different quality reconstructions for reasons that
   have nothing to do with PKR quality (agent capability differences), muddying the
   M3/M4 signal. Mitigate by running M3 with more than one agent/model where
   feasible before drawing conclusions.
5. **Secret-scan false negatives.** Pattern/entropy-based scanning is inherently
   incomplete; a missed secret written into `.projectknowledge/` (which may get
   committed to Git) is a real harm, not a cosmetic bug. Needs its own test suite
   with known secret formats before M1 ships, and should default to conservative
   (over-redact) rather than permissive.

## 13. Major product risks

1. Developers may not trust an AI-generated "spec of my project" enough to review
   and confirm it — the human-correction step could become a bottleneck nobody does,
   making the whole knowledge graph permanently stuck at `inferred`.
2. The value proposition is strongest for *someone else* reconstructing *your*
   project (onboarding, cross-agent portability) — but the person doing the
   `pkr export` work is rarely the direct beneficiary, a classic incentive mismatch
   that could suppress adoption regardless of technical quality.
3. If AI coding agents get good enough at reading a raw repository directly, the
   marginal value of a curated knowledge layer shrinks. The bet is that structured,
   confidence-labeled, traceable knowledge stays more reliable than repo-reading
   alone even as base models improve — this is falsifiable by M3/M4 and should be
   revisited there.

## 14. Where the idea may fail

- If M3/M4 show that reconstruction quality with the PKR is not meaningfully better
  than a good README + repo access, the core hypothesis is falsified and the product
  should not proceed to the hosted platform in this form.
- If human correction never happens in practice, "confirmed" status becomes
  theoretical and the format degrades to "confidently-worded inferred," undermining
  Rule 2 in practice even though it's enforced in the schema.

## 15. Explicitly not building yet

Per `PRODUCT_SPEC.md` §6 / PROMPT §29 — no collaborative editing, orgs/teams/
permissions, GitHub/GitLab auto-sync, PR-based updates, IDE plugins, MCP server,
agent API, knowledge merge conflicts, branch-like versions, public PKR repos, a
package registry, an agent marketplace, or automated benchmarking-as-a-service. The
storage model (§7) leaves room (`parent_version_id`, project-scoped everything) but
none of it is implemented.
