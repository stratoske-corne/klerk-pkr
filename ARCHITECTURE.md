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
| Stage 3 — Interface analysis | ✅ built: HTTP routes (Express/Fastify/Koa-style direct calls **and** `router.route(x).get()/.post()/...` chains + Next.js file routing), DB schema (Prisma + raw SQL `CREATE TABLE` + **Mongoose `Schema`/`model()` pairs**), external services (dependency lookup). The two bolded items were the M3-discovered gaps (§16) — both fixed 2026-08-16, tested against fixtures modeled on the real repo that surfaced them (§16/§18). Event detection not built. (`extract/interfaces.ts`) |
| Stage 4 — Structure analysis | ✅ built (`extract/structure.ts`) |
| Stage 5 — Test & environment analysis | ❌ not built |
| Stage 6 — Semantic synthesis (LLM) | ✅ built (`extract/synthesize.ts`, `llm/anthropic.ts`) — proposes `requirement`/`user-flow`/`domain-concept`/`business-rule`/`invariant`/`edge-case`/`error-behavior` nodes. Requires `ANTHROPIC_API_KEY`; skips gracefully (deterministic-only export) if unset or `--no-llm` is passed. Every claimed evidence path is checked against what was actually shown to the model (excerpt content or an observed node's evidence pointer), not the whole repo inventory — unverifiable ones are dropped and reported, weakly-grounded ones (real path, content never shown) are kept but flagged separately, not softened silently. `architecture/overview.md` narrative synthesis not built (no matching node type yet). **2026-08-16, first real (non-standing-in) API validation** (§16 Run 3) found and fixed three gaps in one session, each confirmed by a real API call before being traced and fixed: (1) `buildExcerpts()` silently excluded `docs/` subdirectories, (2) the file with the actual business logic was never an excerpt candidate under any selection rule (new size-based fallback added), (3) evidence verification accepted any real repo file, not just paths actually shown to the model (now tiered: excerpt-backed vs. fact-summary-only, the latter flagged as `weaklyGrounded`). Clean before/after on the same repo+model for (1)+(2): proposed nodes went from surface-level-only to correctly capturing every real business rule. |
| Stage 7 — Render & write | ✅ built (`render/render.ts`), including the secret write-gate |
| `pkr export` CLI (aliased `pkr init`) | ✅ built (`packages/cli`), flags: `--out`, `--no-llm`, `--model` |
| `pkr context` | ✅ built (`packages/core/src/context/`) — renders a single continuation-context file (`PROJECT_CONTEXT.md` / `CLAUDE_CONTEXT.md` / `AGENTS_CONTEXT.md` per `--target`) from a PKR, framed for "keep working on this existing project," not "rebuild it." Per-target content differentiation is a stub (identical facts, different filename/framing note) — real differentiation deferred until a concrete need shows up. See §17 for why this — not `pkr reconstruct` — is the primary product surface. **2026-08-16 addition** (the "agent-instruction, not a daemon" automation route, chosen over a file-watcher or git hook — see chat log rationale): the rendered file now (a) tells the agent explicitly to run `pkr update <repo>` when it finishes making changes, and (b) runs a best-effort staleness check (`--repo`, defaults to the PKR dir's parent) reusing `pkr update`'s own `diffInventory` machinery, surfacing a changed-file count or an honest "unknown" rather than silently assuming freshness. Found and fixed a real bug while verifying this live (not just via fixtures): `.context/`/`.reconstruction/` weren't in `extract/inventory.ts`'s `ALWAYS_IGNORE`, so writing a context file counted as drift against *itself* on the very next run — regression-tested in `context/index.test.ts`. |
| `pkr update` (incremental) | ✅ built (`packages/core/src/update/`) — diffs the current repo against a persisted file-hash inventory (`.knowledge/inventory.json`, new), re-runs deterministic extraction in full (cheap, no LLM) and merges the result against the stored graph by a per-type natural key (package name / title), reusing node IDs for unchanged facts and reporting a semantic diff (added/modified/removed), not a text diff. Confirmed-node protection verified end-to-end with a real bug found and fixed: the merge path was letting a confirmed node's `confirmed_by` leak onto the merged candidate, which silently defeated `FileNodeStore.upsertNode`'s protection check — now produces a `conflicts_with` edge instead (the first edge this codebase has ever produced). `--llm` re-runs stage 6 and now reconciles against existing inferred knowledge (§19, implemented 2026-08-16, motivated by a real bug found in §16 Run 4): the model is shown current inferred nodes and can mark ones it replaces via `supersedes`; `update/reconcileInferredNodes.ts` turns that into a `conflicts_with` edge (confirmed target — untouched, human resolves) or a `supersedes` edge (non-confirmed target — kept in the store, excluded from the main rendered files into a new `superseded.md`). Real-call validated same day (§19): correctly proposed the new rules and correctly superseded exactly the one stale node whose content had actually gone wrong, while leaving a related-but-still-accurate node alone. Same real call also exposed and led to fixing a second, older, unrelated bug — `knowledge-map.json` silently rendered every edge as `{}` (a `JSON.stringify` replacer-array misuse dating to M1, only ever visible once a real edge existed to render). Real Knowledge Versioning (`PKR_SPEC.md` §7 — `v0.1`→`v0.2`, `pkr commit`) still not built; every render currently reports `knowledge_version: v0.1`. |
| `pkr reconstruct` (M2) | ✅ built (`packages/core/src/reconstruct/`) — loads a `.projectknowledge/` dir (internal `.knowledge/*.jsonl` store, or a markdown-fallback parser when that store isn't present — PKR_SPEC.md §8 portability, verified byte-identical output both ways), computes a phase-order build order (currently pure phase-order — no edges exist yet to topo-sort within a phase), and renders `.reconstruction/{SYSTEM_PROMPT,BUILD_ORDER,CONSTRAINTS,ACCEPTANCE_TESTS,CONTEXT,KNOWN_AMBIGUITIES}.md`. No LLM call. `ACCEPTANCE_TESTS.md` now pulls real `npm run build`/`test` commands (stage 2 extracts them from `package.json` scripts) plus expected endpoints/tables straight from extracted nodes. |
| Automated test suite | ✅ built. `packages/core` (vitest): 94 tests / 16 files, all deterministic (no network, no LLM, tmpdir-isolated fixtures — nothing touches the real repo tree). Covers: node-factory's schema-boundary enforcement (status/confidence/evidence rules), `IdAllocator` sequencing and 4-digit rollover, `FileNodeStore`'s confirmed-node protection (upsert + delete), the secret write-gate, `computeAchievableLevel`'s threshold behavior (including level 4 now being a genuinely reachable, distinct output), `naturalKey`/`diffInventory`, `pkr update --llm`'s failure-doesn't-forfeit-a-retry behavior, stage 3's route/schema detectors (`extract/interfaces.ts` — including the two M3-fixed gaps below), stage 6's excerpt-selection heuristic, evidence-grounding tiers, and §19 reconciliation (`extract/synthesize.ts` — via a no-op/fake LLM so these run free), `update/reconcileInferredNodes.ts`'s confirmed/non-confirmed split, and `supersede.ts`'s exclusion logic exercised across all three render paths (`render.ts`'s `superseded.md`, `pkr context`, `pkr reconstruct` — each with its own regression test reproducing the literal $500-next-to-$1,000 contradiction), `pkr context`'s staleness check (including the `.context`-counts-as-its-own-drift regression below), and — the highest-value additions — a `mergeNodes` regression test that reintroduces the confirmed-node-leak bug found this session and confirms it's caught (verified by hand: reverting the fix makes exactly those 2 tests fail, nothing else), a full `pkr export` → `pkr update` integration test (no-op, real change, confirmed-conflict, and the §19/Run-4 reconciliation scenario end-to-end), and a `loadPkr` jsonl-vs-markdown-fallback parity test. `packages/cli` (vitest, added 2026-08-16): 11 tests, spawns the real compiled `bin/pkr.js` as a subprocess — the one surface the core-level tests never touch. Found by actually running the CLI the way a first-time user would (bad paths, no PKR yet, typos): every single error case crashed with a raw, uncaught Node.js stack trace pointing into compiled `dist/` files instead of the clean, already-well-written `Error` message underneath — `program.parseAsync(...)` had no top-level `.catch()`, so any action handler's rejection reached the runtime uncaught. Fixed with one central handler (clean `Error: <message>`, `process.exitCode = 1`, full stack still available behind `PKR_DEBUG=1`) rather than wrapping each of the 4 commands' actions individually — same "fix it where it actually reaches the user, once, consistently" lesson as the superseded-node fix above. Regression-tested (reverting reproduces the exact crash-with-stack-trace symptom for all 4 commands, confirmed by hand) alongside baseline commander-dispatch coverage and a real end-to-end `export`/`init` happy-path smoke test. Not yet covered: stage 4 directly (structure.ts). |
| `pkr compare` | ❌ not built |
| Hosted platform (M6+) | ❌ not built, by design (§7) |

Validated end-to-end against: this repo, `packages/core` standalone, a cloned copy
of `expressjs/express`, a small fixture repo exercising Prisma + Stripe/Postgres
dependency detection + Express routes, and (live, real API key, user-supplied)
`claude-sonnet-5` synthesizing this repo's own `product/`/`behavior/` layers —
15 proposed nodes, 0 dropped, confidence honestly varied 0.60–0.90. See §16 for
two full M3 loop runs (export → reconstruction → blind agent): a real external
repo (Run 1, contamination-limited) and a synthetic fixture built specifically
to test whether a deliberately asymmetric business rule survives reconstruction
(Run 2 — it did).

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

## 16. M3 findings log

Running record of full-loop (`PRODUCT_SPEC.md` §8 Phase A–E) runs. Append, don't
overwrite — this is the evidence base for M4/M5 schema revisions.

### Run 1 — `hagopj13/node-express-boilerplate` (2026-08-15)

Setup: real external repo (Express + Mongoose + JWT auth boilerplate, not
previously read in this session), deterministic export → hand-authored-but-genuine
stage 6 synthesis (grounded in an actual first read of the repo, standing in for a
live API call) → `pkr reconstruct` → a `general-purpose` subagent with **zero**
shared context, given only the six `.reconstruction/` files, told to build a real
working implementation from them alone.

**What worked:**
- Both real gaps below were caught *because* the deterministic layer was tested
  against unfamiliar code, not a fixture built to exercise our own regexes.
- The reconstruction agent independently produced a directory layout (`models/`,
  `controllers/`, `services/`, `routes/v1/`, `middlewares/`, `validations/`,
  `utils/`, `tests/{unit,integration,fixtures}`) matching the phase groupings in
  `BUILD_ORDER.md` — the package's structure genuinely steered it.
- `CONSTRAINTS.md`'s exact `dependency` nodes (name + version range, `observed`,
  from `package.json`) reproduced an **exact** dependency list in the rebuilt
  `package.json` — this is expected and correct, not contamination: it's
  `observed` data transcribed exactly, which is exactly what `observed` status
  promises.

**Two real deterministic-stage gaps found (repo, not our fixtures, surfaced these):**
1. ~~`extract/interfaces.ts`'s route regex only matches `router.get('/x', ...)`
   call-per-verb style. This repo's user-management routes use chained
   `router.route('/x').get(...).post(...)` — **zero** of those were detected.
   Real blind spot, not a hypothetical one.~~ **Fixed 2026-08-16** —
   `detectChainedRoutes` in `extract/interfaces.ts` walks `.route(x)` chains
   call-by-call using a bracket-balancing helper (`skipBalanced`) so a
   handler's own body can't derail the walk. Tested against a fixture modeled
   directly on this repo's `user.route.js` shape (`extract/interfaces.test.ts`).
2. ~~No Mongoose schema detection at all (`db-table` extraction only recognizes
   Prisma `schema.prisma` and raw SQL `CREATE TABLE`). Two real Mongoose models
   (`User`, `Token`) in this repo produced zero `db-table` nodes — this is also
   why the achieved reconstruction level capped at 2 instead of 3 (PKR_SPEC.md §3
   level 3 requires a `db-table` node to exist).~~ **Fixed 2026-08-16** —
   `analyzeMongooseModels` in `extract/interfaces.ts` binds `new Schema({...})`
   declarations to `mongoose.model('Name', schemaVar)` calls by variable name
   within a file (both `mongoose.Schema`-prefixed and destructured
   `import { Schema, model }` styles), extracting top-level field names/types.
   A schema imported from another module is a documented remaining gap — the
   model node still gets created, just without field detail. Tested against a
   fixture modeled on this repo's `user.model.js` (options-object 2nd arg,
   nested validator function body, `.pre('save', ...)` hook after the model
   call — none of which should confuse the field parser or produce spurious
   nodes; verified they don't).

**Process failure:** the reconstruction subagent stalled (killed by a 600s
no-progress watchdog) mid-way through debugging a real `joi`/`@hapi/hoek` version
resolution error surfaced by running `npm test` — not a fundamental block, a
realistic dependency-resolution rabbit hole any engineer could hit. Worth adding to
`ACCEPTANCE_TESTS.md`: whether tests need external infrastructure (a live/mocked
DB) so a reconstruction agent can budget for that rather than get stuck debugging
environment noise indefinitely.

**Critical methodology finding — likely training-data contamination:** comparing
the (partial, pre-stall) rebuilt `src/models/user.model.js` against the original
showed **near-verbatim** reproduction — identical function names
(`isEmailTaken`, `isPasswordMatch`), identical regexes, identical bcrypt salt
rounds (`8`), even matching JSDoc comments — none of which were ever present in
the PKR (the synthesized nodes described the *rules*, e.g. "passwords hashed with
bcrypt before persistence," never the literal code). No `WebSearch`/`WebFetch` tool
calls appear in the subagent's transcript, so this isn't live lookup — the most
likely explanation is that this specific repo is popular and old enough
(500+ forks, referenced in many tutorials) to be memorized in the model's
pretraining. **This means Run 1's result cannot be used as clean evidence that the
PKR content itself was sufficient** — a famous public repo is a bad choice for this
experiment precisely because a capable model may already know it. Corollary:
`EvidenceRef.path` values, rendered verbatim in `CONTEXT.md`/`CONSTRAINTS.md`, also
partially leak the *original's* file organization into the reconstruction prompt
regardless of memorization — worth a design note for M4 (should reconstruction
packages redact original file paths from evidence, or is that acceptable given
PKR_SPEC §3 level 4 explicitly includes "directory conventions" as something to
reproduce?).

**Action items for M4/M5:**
- ~~Fix the two deterministic gaps above (chained route syntax, Mongoose schema
  detection) — both are concrete, testable regressions now.~~ Done 2026-08-16
  (§18); confirmed working end-to-end, not just via fixtures — see Run 2 below.
- ~~Re-run the full M3 loop against an obscure or synthetic repo (not a well-known
  public boilerplate) to get an uncontaminated signal on reconstruction quality.~~
  Done 2026-08-16 — see Run 2.
- Consider whether `ACCEPTANCE_TESTS.md` should flag external-infrastructure
  dependencies (databases, message queues) so a reconstruction agent doesn't stall
  chasing environment issues instead of code issues. Still open — Run 2 sidestepped
  this by design (repository-pattern fixture, no live DB required) rather than
  testing it.

### Run 2 — synthetic `loyalty-points-api` (2026-08-16)

Setup, deliberately different from Run 1 in the one way that mattered: instead of a
real public repo (contamination risk, per Run 1's finding), I wrote a small
synthetic Express + Mongoose service from scratch this session — a customer
loyalty-points API with **six business rules chosen specifically to be
non-obvious from structure alone**, the sharpest being a deliberate *asymmetry*:
redemption spends points FIFO across batches, but a refund reverses the one
specific batch tied to the refunded order — never a FIFO deduction, even after
other activity has touched the account since. A model that "cleans up" this
asymmetry into naive symmetric FIFO would be a concrete, checkable failure. Same
methodology otherwise: deterministic `pkr export` → hand-authored-but-genuine
stage 6 synthesis (grounded in a real read of the repo I'd just written,
standing in for a live API call, same as Run 1) → `pkr reconstruct` → a
`general-purpose` subagent in an isolated worktree, given **only** the six
`.reconstruction/` files, zero other context, told to build a working
implementation and get `npm run build`/`npm run test` passing.

**Result: the blind agent correctly implemented the asymmetric rule, independently verified, not just self-reported.**
I read its `pointsService.js` and test suite myself and re-ran `npm run build` /
`npm test` independently after the agent reported done (47/47 passed, confirmed).
Its own tests specifically constructed the trap scenario — refund a *newer* order
while an *older* order's batch sits at the FIFO front — and asserted the older
batch is untouched. All six business rules, plus the two subtler edge cases
(refund doesn't reverse VIP-qualifying lifetime spend; an expired-but-unpruned
batch still matches a refund lookup by `sourceOrderId`), were implemented
correctly. `NOTES.md` (13 documented assumptions) shows real engineering judgment
on every genuine gap, not guessing dressed up as certainty — e.g. it correctly
noticed the PKR names no HTTP endpoint for `earnFromPurchase` and proposed a
documented workaround rather than inventing unevidenced certainty (this
particular gap turned out to be real: my fixture never actually wires
`earnFromPurchase` to a route — an artifact of the fixture, not the extractor).

**One genuine semantic divergence found, and it's an honest, useful one:**
whether the purchase that itself pushes an account's lifetime spend across the
$500 VIP threshold is counted as VIP for its own multiplier. My original
increments `lifetimeSpendCents` *after* checking VIP status (that purchase is
NOT doubled); the rebuilt version increments *first, then* checks (that
purchase IS doubled). Neither the deterministic extraction nor my stage-6
synthesis ever captured this ordering — I didn't think to write a rule/edge-case
node for it, so `KNOWN_AMBIGUITIES.md` had nothing to flag (our extractor only
flags nodes explicitly `unknown`/`historical-lost`; it doesn't detect
*unasked* questions). This is exactly the failure mode the honesty model is
supposed to produce when it happens — a real gap in what got captured, not a
capability failure — but it's a live example that `KNOWN_AMBIGUITIES.md`'s
current scope (only explicitly-flagged nodes) misses gaps the synthesis step
itself didn't think to ask about. Worth a note for M4/M5: stage 6 should be
prompted to actively flag suspected under-specification (ordering, timing,
concurrency) as `unknown`-status nodes, not just report what it's confident
about.

**Confirms both M3-Run-1 gap fixes work outside unit tests too:** the live
export on this repo detected all 5 API endpoints (3 via the chained
`.route(x).get()/.post()` syntax the fixture deliberately used) and the
Mongoose `Account` model with correct field names/types — and reached
reconstruction level 3, where the equivalent Run-1 repo had capped at 2 for
exactly this reason. One process note: this only worked because `npm run
build` was re-run for `@klerk/core`/`@klerk/cli` before testing — the CLI runs
compiled `dist/`, and editing `src/` alone silently keeps testing the old
behavior. Worth remembering for any future manual CLI validation.

**What this run does and doesn't prove:** it's strong evidence that a PKR
authored with real care conveys nuanced intent well enough for a blind agent to
reproduce it — for a small, single-service backend with no cross-node edges to
navigate. It does not test scale (this was ~10 source files), doesn't test
`pkr update`'s incremental loop end-to-end, and the stage 6 step was still me
standing in for a live API call, not a real one — that substitution has held up
every time this session, but it's not the same as an independent LLM call with
no visibility into how the fixture was designed. Addressed directly by Run 3.

### Run 3 — first real (non-standing-in) LLM call, same `loyalty-points-api` (2026-08-16)

Every prior run carried the same caveat: stage 6 was me reading the repo and
authoring genuine-but-hand-written synthesis, standing in for a live API call.
This run removed that substitution — a real `claude-sonnet-5` call, via
`pkr export` with `ANTHROPIC_API_KEY` set, no hand-authoring, on the same
synthetic repo Run 2 used (rebuilt identically from source since the scratch
copy didn't survive between sessions).

**First real call exposed two concrete extractor bugs, not a model-quality
problem.** `pkr export` succeeded (13 nodes from 5 excerpt files), but the
proposed business-rule/invariant nodes were shallow — surface facts only
(404-on-missing-account, refund-uses-order-id-not-a-points-amount), missing
every one of the six real rules (FIFO order, 540-day expiry, VIP multiplier
scope, 100-point minimum, and the asymmetric-refund rationale). Traced the
cause by replaying `buildExcerpts()`'s candidate-selection deterministically
(no LLM call needed) against the real inventory:
1. `docs/DECISIONS.md` — the one file explaining *why* the asymmetric refund
   rule exists — was silently excluded by the "top-level docs" fallback's
   `!path.includes("/")` check, which rejected every docs subdirectory, not
   just deeply-nested ones.
2. `src/services/pointsService.js` — the file with *all six* business rules
   in its own doc comment — was never a candidate under any of the four
   selection rules: not a README, not a (wrongly-excluded) doc, not cited as
   `api-endpoint`/`db-table` evidence, and its filename doesn't match the
   entry-point regex. Routes/repository files got selected; the actual logic
   layer didn't.

A third, subtler thing surfaced in the same output: one shallow node cited
`src/services/pointsService.test.js` as evidence — a file never sent as an
excerpt at all. It got the path from `summarizeObservedFacts()`, which lists
every stage 1–4 node's evidence paths as plain text (here, a `convention`
node about colocated tests). Evidence verification only checked that a
claimed path exists in the repo inventory, not that the model was actually
shown that file's content — so a real (and here, correct) path could get
attached to a claim the model never read, not just inferred from adjacent
text.

**Fixed same day, separately** (`extract/synthesize.ts`): `knownPaths` no
longer accepts every path in the repo inventory — only paths the model was
actually shown, either as excerpt content or as another observed node's
evidence pointer in the observed-facts summary. That alone closes a real hole
wider than the specific bug above: the old check would have silently accepted
*any* real file in the repo as "verified" evidence, including ones never
mentioned to the model anywhere at all. On top of that, evidence is now
tiered: excerpt-backed (the model read the file) vs. fact-summary-only (the
model only saw the path named, never its content) — the latter is still
accepted (can be legitimate, e.g. citing `package.json` for a fact a stage-2
dependency node already established) but surfaced distinctly as
`weaklyGrounded` in `SynthesisResult`/`SynthesisReport`/`LlmUpdateReport` and
printed by the CLI, so a human reviewing `pkr export`/`pkr update` output
knows exactly which claims were never content-verified. Three cases
regression-tested in `extract/synthesize.test.ts` (excerpt-backed → accepted
clean; fact-summary-only → accepted + flagged; shown-nowhere → rejected
outright) — each verified by hand to fail without the fix, same discipline as
every other fix this session. Not re-validated with a fourth live API call —
the three cases are deterministic path-matching logic, not model behavior, so
the unit tests are the right level of proof here.

**Fixed both extractor bugs** in `extract/synthesize.ts`'s `buildExcerpts()`:
docs-subdirectory detection now allows one level down (`docs/*.md`, not just
bare-root), and a new rule 5 adds the largest remaining source file(s) as a
generic, language-agnostic "probably where the real logic lives" fallback
when nothing else surfaces it. Regression-tested in the new
`extract/synthesize.test.ts` (reverting either fix fails exactly the matching
tests, verified by hand, same discipline as every other fix this session).

**Re-ran the same real API call after the fix — clean before/after, same
repo, same model:** 8 excerpt files (was 5), 18 proposed nodes (was 13), and
this time **all six real business rules were captured correctly**, including
the asymmetric refund rule verbatim-correct in reasoning: *"Refunds are
deliberately NOT implemented as inverse-FIFO redemption, because doing so
could silently remove the wrong batch after intervening purchases/
redemptions, corrupting the balance in a way that's hard to detect"*
(confidence 0.95, evidence: `pointsService.js` + `docs/DECISIONS.md`) — plus
a dedicated invariant node stating the asymmetry "must always be preserved to
keep the ledger auditable and correct."

**Why this matters more than Run 1/Run 2 despite being a smaller test:** it's
the first genuinely independent confirmation that a real model, given the
*correct* inputs, produces the deep synthesis this project has been claiming
— and it's a controlled before/after on the exact same repo and model, not a
different run that might differ for unrelated reasons. It also corrects an
overstatement risk in Run 1/Run 2's conclusions: my own "stand in for stage
6" methodology always read the whole repo by hand regardless of what the real
`buildExcerpts()` would select, so those two runs validated a stronger PKR
than the automated pipeline could actually produce on its own at the time.
Not re-run: the full blind-reconstruction step (Run 2's subagent) against
this real-LLM PKR — the direct before/after on `business-rules.md` already
gives clean, independently-verifiable evidence of what changed and why;
re-running the ~12-minute blind-reconstruction agent on top wasn't judged
necessary to confirm the fix, since Run 2 already established that prose of
this quality is sufficient for one.

### Run 4 — first real `pkr update --llm` validation, same repo (2026-08-16)

Every real-API validation so far (Run 3) tested `pkr export`. `pkr update`'s
LLM path — arguably the more important one, since it's the actual
continuation loop §17 is about — had never been exercised with a real call.
Setup: took the Run 3 repo (real PKR already exported, all 6 rules correctly
captured), then made a genuinely realistic pair of changes a developer or
agent would actually make — raised the VIP threshold from $500 to $1,000
(modifying an *existing* rule) and added a new referral-bonus feature
(a *new* rule), both with matching `docs/DECISIONS.md` rationale — then ran
`pkr update --llm` for real.

**Process finding first, before the interesting result:** the very first
attempt hit the account's spend cap mid-run. Because `runUpdate` persists the
fresh file-hash baseline (`saveInventory`) unconditionally, *outside* the
try/catch around the stage-6 call, the failed attempt still advanced the
baseline to the already-changed code. Retrying immediately then reported
"✓ Up to date — no file changes detected" and skipped stage 6 entirely
*without ever having successfully synthesized anything for those changes* —
a real reliability gap: a transient LLM failure (rate limit, network,
overload) silently and permanently forfeits that update's semantic-layer
sync unless something changes again before the next `pkr update` run.
Worked around for this test by making one more trivial content edit to force
a fresh diff.

**Fixed 2026-08-16** (`update/index.ts`), exactly the direction sketched
above: `saveInventory` is now skipped specifically when stage 6 was
requested and failed (`options.llm` set, `llmReport.ranSuccessfully ===
false`) — the deterministic merge results are still saved either way
(re-running `mergeDeterministicNodes` against an already-merged store on a
retry is a safe no-op, natural-key matching sees those facts as already up
to date, so there's no cost to keeping them). Effect: a retry with no
further code changes now genuinely re-attempts stage 6 instead of
short-circuiting as "up to date." Three new tests in
`update/index.integration.test.ts` with a `LlmClient` that always throws:
the baseline doesn't advance on failure and a retry still sees the change
(reverting the fix reproduces the exact silent-swallow symptom, confirmed
by hand); deterministic results survive an LLM failure in the same run;
and a retry succeeds normally once the LLM starts working again, correctly
becoming genuinely "up to date" only after that. CLI's failure message now
says so explicitly (`pkr update --llm again to retry`) instead of leaving
the user to infer it.

**The result, once stage 6 actually ran: it correctly captured both
changes.** `RULE-POINTS-011` ("VIP threshold raised to $1,000") and
`RULE-POINTS-016` ("Referral bonus is a flat 200 points on referred
account's first purchase") were both proposed, correctly grounded in
`pointsService.js` + `docs/DECISIONS.md`, with an honest confidence (0.60 —
lower than the other rules, since these are newer/thinner-evidenced changes,
exactly the calibration the system prompt asks for).

**But this is the clearest, most concrete demonstration yet of the
documented "additive-only" limitation (ARCHITECTURE.md `update/index.ts`
module doc) — not hypothetical, directly observed in the rendered output.**
`pkr update --llm` added 18 *new* nodes; it did not touch, retire, or link
against any of the 15 nodes from the original export. The result, sitting in
the same rendered `business-rules.md`, same `node_ids` list, with no
relationship recorded between them:
- `RULE-POINTS-002` (original, unchanged): *"Accounts with lifetimeSpendCents
  >= $500 get a 2x multiplier..."* — **now factually wrong**.
- `RULE-POINTS-010` (new, this run): *"Accounts with lifetime spend >=
  $1,000 get a 2x multiplier..."* — same title as -002, correct content.
- `RULE-POINTS-011` (new, this run): *"VIP threshold raised to $1,000"* —
  the change itself, as its own node.

A human or an AI agent reading `pkr context`'s output today would see the
stale $500 claim and the correct $1,000 claim in the same file, same
section, with nothing marking one as superseded — worse than not having the
old fact at all, since it now actively contradicts the new one instead of
just being silently missing. This is exactly why `supersedes` and real
Knowledge Versioning (PKR_SPEC.md §7, `manifest.yaml`'s `knowledge_version`
still hardcoded `v0.1` — ARCHITECTURE.md §0) matter beyond bookkeeping: this
specific failure mode is what they'd prevent.

**Action item, now the clear top priority for the LLM-synthesis path:**
design and build reconciliation for `pkr update --llm` — likely re-running
stage 6 with the *existing* inferred nodes shown as prior context (not just
observed facts) and asking the model to explicitly mark which are
superseded/still-valid/contradicted, rather than only ever proposing net-new
nodes. Bigger than every fix so far this session — worth a real design pass
before writing code, not a quick patch.

Recorded because it changes what gets built next, not just a UI label.

Rebuild-from-scratch (`pkr reconstruct`, M2) was always meant as an internal
*benchmark* for PKR completeness (`PRODUCT_SPEC.md` §8 says this explicitly: "the
success metric is not whether the documentation looks good"). But the actual
build/test work in M1–M3 exercised it as if it were the product surface, and a
real user session (2026-08-15) surfaced why that's the wrong emphasis: **nobody
wants a working project rebuilt from Markdown — the code already exists and
runs.** The value users actually described:

1. Open an unfamiliar repo, run `pkr init` (alias of `export`), then ask an AI
   agent questions ("how does auth work", "why Redis here", "what would this API
   change break") *instead of* reading 300 files cold.
2. An agent makes real changes; the PKR updates to reflect them (code diff →
   semantic diff → human-approved knowledge update — `pkr update`, not built yet).
3. Tomorrow, a *different* agent/model opens the same repo, is hand the PKR, and
   picks up the work with no re-explanation — this is the literal content of
   `PRODUCT_SPEC.md` §1/§31 ("the knowledge layer survives the AI session, model,
   and coding environment"), just stated as a concrete workflow instead of an
   abstraction.

This reprioritizes, but doesn't discard, anything already built: the extraction
pipeline, evidence/confidence model, and node/edge schema serve continuation just
as much as reconstruction — only the *shipped-facing* surface changes. Consequence:
`pkr context` (§0) — a continuation-framed package, deliberately distinct from
`.reconstruction/`'s "build this from nothing" framing — is now a primary CLI
command, not a stub. `pkr reconstruct` stays, demoted to what it always should have
been: a quality benchmark (§16), not the pitch.

**Not yet built, now the priority for the next slice:** `pkr update` with semantic
diff (PKR_SPEC.md's Knowledge Diff concept, PROMPT §9) — detect what changed since
the last export, re-run stage 6 scoped to the affected node neighborhood, and
produce a human-reviewable summary ("2 API contracts changed, 3 business rules
added, 1 prior decision may no longer hold") instead of a wall of re-generated
Markdown. This is the mechanism that makes the PKR trustworthy as *current*, which
is the precondition for the cross-agent continuity story above actually working.

(`pkr update` shipped shortly after this was written — see §0's row for it.)

## 18. Automated test suite

Added 2026-08-16, before any further feature work, on the reasoning that
`mergeNodes.ts` — the confirmed-node-protection logic — had already shipped one
real overwrite bug (§0, found and fixed by hand during manual testing) and had no
safety net stopping it from regressing silently. See §0's "Automated test suite"
row for coverage. `packages/core/vitest.config.ts`, tests live next to the modules
they cover (`*.test.ts`).

The regression tests were verified to actually regress: the confirmed-node-leak
fix in `mergeNodes.ts` was temporarily reverted and re-run against the suite —
exactly the 2 tests naming that bug failed, all others stayed green, then the fix
was restored.

**New finding from writing `levels.test.ts`:** `computeAchievableLevel` (`levels.ts`)
can never return `4` as an output. Level 4's last condition and level 5's only
condition are the same flag (`hasReconstructionArtifacts`) — so any node set that
satisfies level 4 automatically satisfies level 5 too, and the function jumps
straight from 3 to 5. This predates the test suite (introduced when reconstruction
levels were first computed, M1) and is orthogonal to the confirmed-node bug above —
recorded here rather than silently fixed because "5" is a claim rendered directly
into every PKR's `README.md` and `manifest.yaml`, and the fix depends on deciding
what actually distinguishes level 4 from level 5 in evidence terms (PKR_SPEC.md §3
says level 5 needs "machine-checkable validation criteria" — arguably a distinct
signal from merely having reconstruction artifacts, e.g. whether
`validation.commands` is populated).

**Fixed 2026-08-16.** `LevelInput` now takes `hasValidationCriteria` as a
genuinely separate field from `hasReconstructionArtifacts`, so the two can
never silently collapse into one flag again — level 4 requires the latter
(PKR_SPEC.md §3: a reconstruction package with `deterministic-constraints.md`
exists), level 5 additionally requires the former (machine-checkable
acceptance criteria specifically). `render.ts`'s one call site wires
`hasValidationCriteria` to a real, already-available signal — stage 2's
extracted build/test commands (`validationCommands`) — rather than leaving
it hardcoded, so the fields can't drift back into being redundant by
accident. `hasReconstructionArtifacts` stays hardcoded `false` at that call
site, correctly: `.reconstruction/` is `pkr reconstruct`'s output, generated
in a separate, later step this render call has no way to know about — so
levels 4/5 remain **currently unreachable in practice** from `pkr export`/
`pkr update` alone, same as before this fix. That's a real, known, and
honestly-conservative limitation, not a bug — the bug was specifically that
level 4 could never be an output even in principle (any caller supplying
`hasReconstructionArtifacts: true` got 5, never 4). A future `pkr
reconstruct` writing an achieved level back into the original PKR's manifest
once its own artifacts exist would be the honest way to close the remaining
gap — out of scope here, a distinct future task, not conflated with this
fix. Regression-tested in `levels.test.ts` (level 4 reachable and distinct
from 5; reverting the fix reproduces the exact 3→5 jump, confirmed by hand).

## 19. Design: `pkr update --llm` reconciliation — superseding stale inferred knowledge

Motivated directly by §16 Run 4: a real call correctly proposed the *new*
facts (VIP threshold raised, referral bonus added) but left the *old*,
now-wrong fact (`RULE-POINTS-002`, still claiming the old $500 threshold)
sitting in the same rendered file with no relationship recorded — actively
contradictory, not just stale-by-omission. Written as a design doc before any
code, per the process this session has followed for every non-trivial change
(design first, smallest useful slice, test before trusting).

**✅ Implemented 2026-08-16, exactly as designed below** — every piece: the
`<existing_knowledge>` prompt block, the optional `supersedes` response
field (verified against what was actually shown, same discipline as Run 3's
evidence-path fix), `update/reconcileInferredNodes.ts` (confirmed → 
`conflicts_with`, non-confirmed → `supersedes`, reusing `mergeNodes.ts`'s
protection pattern exactly), `render.ts` excluding non-confirmed superseded
nodes from the main files into a new `superseded.md`, and the CLI's new `~
superseded ...` / `!` conflict lines. 13 new tests across 4 files (all
4 unit-test cases from the plan below, fake-LLM/no-API-cost, each verified
by hand to actually regress when reverted — same discipline as every fix
this session), plus the end-to-end case: the exact §16 Run 4 scenario
(pre-existing stale $500 node, a fake LLM proposing the $1,000 correction
with `supersedes` set) reproduced in `update/index.integration.test.ts` and
confirmed fixed — the stale ID no longer appears in `business-rules.md`,
appears in `superseded.md` instead, and the underlying node is still in the
store (nothing deleted). Test plan item 5 (a real API call re-running this
exact scenario) is **also done** — the spend cap lifted same-day. Real,
independent `claude-sonnet-5` call, same synthetic repo rebuilt fresh, same
VIP-threshold + referral-bonus change: it correctly proposed the new rules
*and* correctly recognized `DOM-POINTS-003` ("VIP Account", explicitly
stating the old $500 figure) as superseded by the new
`RULE-POINTS-011` — the CLI printed the new `~ superseded ...` line for
real, `DOM-POINTS-003` disappeared from `domain-model.md`, and appeared in
`superseded.md` with its original $500 content intact plus the "superseded
by" pointer. Notably, the model did **not** flag `RULE-POINTS-002` (a
different existing node stating the multiplier-scope rule without the
dollar figure) as superseded — correctly recognizing that rule's content
is still accurate even though the threshold changed, exactly the
"don't supersede just because a topic is related" restraint the system
prompt asks for.

**A second real, previously-undiscovered bug found by this same real call**
(not the reconciliation feature's fault — this one predates it back to M1):
`knowledge-map.json` rendered every edge as `{}` the moment this codebase
ever produced a non-empty edge list to render, which had never happened in
a real run before. Cause: `JSON.stringify(obj, Object.keys(obj).sort(), 2)`
— the second argument is a property *allowlist* applied at every nesting
level, not "sort these keys" (a natural-looking but wrong idiom). Top-level
keys (node IDs) were in the allowlist; nested edge objects' own keys
(`target`, `relationship_type`) weren't, so they were silently stripped.
`source-map.json`'s identical-looking call never showed this because its
values are arrays of plain strings — array elements aren't filtered by the
allowlist, only object properties are. Fixed by sorting into a fresh object
before stringifying and passing `null` as the replacer, applied to both call
sites for consistency. Regression-tested in `render.test.ts` (reverting
reproduces the exact `{}` shape found live) and reconfirmed against the
real PKR after the fix — `knowledge-map.json` now contains the real
`supersedes` edge.

**A third bug, found by asking "does this fix actually reach the surfaces
that matter?" rather than by running anything new:** `render.ts`'s
superseded-node exclusion only ever applied to the main `.projectknowledge/
*.md` files. `pkr context` (the file an agent actually reads) and `pkr
reconstruct` are two *separate* render paths over the same node/edge graph —
neither had been touched, and `context/render.ts` didn't even have an
`edges` parameter to filter with. The exact Run 4 contradiction (stale $500
fact next to the correct $1,000 one) was still fully reproducible through
either command after the "fix" shipped. Caught by re-examining the fix's
actual reach immediately after landing it, not by a new test failing on its
own — worth noting as a gap in how this was verified the first time, not
just a gap in the code.

Fixed properly this time: pulled the exclusion logic into a new shared
module, `supersede.ts` (`computeSupersededIds(nodes, edges)`), used by all
three render paths now instead of a copy living only in `render.ts`. `pkr
context` omits a superseded node outright (no dedicated section — it's a
single-purpose continuation aid, not the permanent record); `pkr reconstruct`
does the same (a build spec has no use for a fact already known wrong).
Regression-tested in both (`context/index.test.ts`, new
`reconstruct/index.test.ts`) — each reverts to reproduce the literal $500-
next-to-$1,000 contradiction, confirming the tests actually catch what they
claim to. **Lesson for next time a cross-cutting fix like this lands:** grep
for every place a `KnowledgeNode[]` gets rendered before calling a fix like
this done, not just the one place a bug report pointed at.

### Why reconciliation is harder than the deterministic case

`mergeNodes.ts` already solves this problem for deterministic facts, cleanly:
a *natural key* (`update/naturalKey.ts` — package name, directory path, route
signature) lets a fresh extraction pass recognize "this is the same fact as
before" even though IDs are allocator-assigned, not content-derived. That
doesn't exist for inferred facts and can't be built the same way — `naturalKey()`
works because deterministic titles are mechanically derived from stable
source (a `package.json` key, a route path). An LLM's title for the same
underlying rule can legitimately vary call to call ("VIP 2x multiplier
applies only to purchase-earned points" vs. a paraphrase), and — as Run 4
showed — the model itself may *split* one old fact into two new ones (a
restated rule + a separate "what changed" node). No deterministic string-
matching heuristic reliably catches that; matching this requires the same
kind of judgment that produced the facts in the first place.

### Chosen approach: let the model self-report supersession, from context it's actually shown

Rather than inventing a new similarity-matching mechanism, feed the model
the *existing* inferred knowledge as a third context block (alongside the
current `<observed_facts>` and `<repository_excerpts>`) on `pkr update --llm`
runs only — there's nothing to reconcile against on a first `pkr export`, so
this block is empty/omitted there:

```
<existing_knowledge>
[RULE-POINTS-002] (business-rule) VIP 2x multiplier applies only to purchase-earned points
  Accounts with lifetimeSpendCents >= $500 get a 2x multiplier...
...
</existing_knowledge>
```

Capped the same way `summarizeObservedFacts()` already caps observed facts
(`MAX_OBSERVED_SUMMARY_ITEMS`) — a new `MAX_EXISTING_KNOWLEDGE_ITEMS`
constant, same spirit, same file. Content is truncated per item (not just
title) — the model needs enough of the old claim to judge contradiction, not
just a label to string-match against.

The response schema gains exactly one new optional field per proposed node:

```jsonc
{ "type": "...", "title": "...", "content": "...", "confidence": 0.0,
  "domain": "...", "evidence": [...],
  "supersedes": ["RULE-POINTS-002"] }  // NEW, optional, IDs from <existing_knowledge> only
```

Rejected alternative: restructure the response into explicit actions
(`{"action": "new"|"update"|"retire", ...}`, considered as "Option A/full
reconciliation" during design). Rejected because it's a much bigger prompt/
schema/validation surface for the same outcome the additive `supersedes`
field already gets, and every other stage-6 change this session has been
a minimal, additive schema field (`weaklyGrounded`'s tiering added zero new
required fields) — consistency with that pattern was weighed deliberately,
not just chosen for less code.

### Validation (same evidence-grounding discipline as everything else in synthesize.ts)

A claimed `supersedes` ID is only honored if:
1. It's an ID actually present in the `<existing_knowledge>` block shown
   this call (mirrors the Run 3 evidence-path fix exactly — a claim about
   something never shown is rejected, not trusted because it happens to be
   a real ID).
2. It resolves to a node of an LLM-synthesizable type (`SYNTHESIZABLE_TYPES`)
   — attempting to supersede a *deterministic* node is out of scope and
   rejected; that's `mergeNodes.ts`'s job, by natural key, not this path's.

An invalid `supersedes` entry is dropped silently from that one node (logged
as a lower-severity note, not a full node rejection like `skipped` — the new
node's own evidence can still be perfectly valid even if one supersede claim
in it wasn't shown).

### Reconciliation logic — reuses the confirmed-protection pattern verbatim, doesn't reinvent it

New module, `update/reconcileInferredNodes.ts`, structurally mirroring
`mergeDeterministicNodes()`'s shape (`NodeMergeReport` → a parallel
`InferredReconcileReport`). For each accepted new node with verified
`supersedes` targets, split by the target's current status:

- **Target is `confirmed`:** never touched or hidden — same rule as
  `FileNodeStore.upsertNode`'s existing check, applied here explicitly
  rather than relying on ID collision to trigger it (new inferred nodes get
  fresh IDs, so they'd never hit that check by accident the way a
  deterministic merge does). Create a `conflicts_with` edge
  (new → target, the same `RelationshipType` `mergeNodes.ts` already uses),
  report it exactly like a deterministic conflict (reuses the CLI's existing
  `!` line format). A human resolves it; nothing is decided silently.
- **Target is not confirmed:** create a `supersedes` edge (new → target —
  this `RelationshipType` has existed in `types.ts` since M1 and has never
  been emitted by any code path until this) and set the new node's own
  `supersedes` field (also in the schema since M1, same story) to the first
  target ID. Target node is **not deleted** — see rendering, below.

No automatic retraction happens without a positive `supersedes` claim from
the model in that same call. A rule that silently stops being reproduced
(no new node references it at all) is left exactly as-is. This is a
deliberate extension of `mergeNodes.ts`'s own stated principle ("traded
deliberately for the much safer failure mode... duplication you can spot and
merge by hand, vs. silent loss") to the inferred side: no positive evidence
of staleness means no action, even though that means Run-4-style
contradictions can still occur if the model doesn't notice/report the
relationship. Reconciliation quality is bounded by what the model reports,
same as synthesis quality already is — not a new kind of risk, the same one.

### Rendering — where this actually fixes the Run 4 symptom

The bug a human would actually see was the contradiction sitting in
`business-rules.md`. Fixing the data model without changing `render.ts`
would leave that visible. Superseded-but-not-confirmed nodes are excluded
from the normal per-type files (`renderProjectKnowledge`'s existing `byFile`
grouping, one added filter: skip a node if it's the target of a `supersedes`
edge and its own status isn't `confirmed`) — and instead written to one new
consolidated file, `superseded.md` at the PKR root, grouped by original
section, each entry showing the old content plus "→ superseded by
`<title>` `<new-id>`".

Rejected alternative: omit superseded nodes from rendered output entirely
(only keep them in `.knowledge/*.jsonl`). Rejected because it breaks
PKR_SPEC.md §8's portability guarantee — a PKR handed around as plain
Markdown (no `.knowledge/` store) would silently lose this history, which is
exactly the kind of audit trail (PKR_SPEC.md §4.2's whole reason for
`conflicts_with` existing) this project has consistently chosen not to
discard elsewhere.

### CLI output

`pkr update --llm`'s diff report gains one new line kind alongside the
existing `+`/`~`/`!`:

```
  ~ superseded RULE-POINTS-002 "VIP 2x multiplier applies only to purchase-earned points"
      → replaced by RULE-POINTS-010 "VIP 2x multiplier applies only to purchase-earned points"
```

Confirmed-target conflicts print with the *same* wording already used for
deterministic conflicts (`"... is confirmed but extraction now disagrees —
needs manual review"`) — one mental model for "something needs your review,"
regardless of which layer produced it.

### Testing plan (before this ships, same discipline as every fix this session)

All with a fake `LlmClient` (free, fast) except the last:
1. Non-confirmed target → `supersedes` edge created, new node's
   `supersedes` field set, target excluded from its normal section file,
   present in `superseded.md`.
2. Confirmed target → `conflicts_with` edge created, target **unchanged**
   and still rendered normally (byte-for-byte, same assertion style as the
   existing `mergeNodes.test.ts` confirmed-protection regression test).
3. A `supersedes` ID not present in `<existing_knowledge>` this call →
   dropped, rest of that node's evidence/content unaffected, no crash.
4. No `supersedes` field on any proposed node → current additive-only
   behavior exactly preserved (regression guard for the 73 existing tests —
   this must stay backward compatible, the field is optional).
5. **Real-call regression, once the account's spend cap allows it:** rebuild
   the exact §16 Run 4 fixture and re-run `pkr update --llm` — confirm
   `RULE-POINTS-002` no longer appears in the rendered `business-rules.md`
   and does appear in `superseded.md`, superseded by the correct new node.
   This is the actual bug that motivated the design; a unit test proves the
   mechanism works, only a real call proves the *model* reliably uses it.

### Open judgment call, flagged for pushback

Keeping superseded nodes in a dedicated `superseded.md` (vs. deleting them
outright) is the one real product choice in this design, not just an
implementation detail — I defaulted to "keep, don't delete" because it's
consistent with every other retention choice already in this codebase
(`historical-lost` status, `conflicts_with` over silent overwrite, portable
`.knowledge/*.jsonl`), but it's the one place someone could reasonably want
the opposite (a leaner PKR, no history file) and I haven't validated that
preference either way.
