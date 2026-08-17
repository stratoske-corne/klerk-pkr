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
| Stage 3 — Interface analysis | ✅ built: HTTP routes (Express/Fastify/Koa-style direct calls **and** `router.route(x).get()/.post()/...` chains + Next.js file routing, **now with single-level router mount-prefix resolution** — §20), DB schema (Prisma + raw SQL `CREATE TABLE` + Mongoose `Schema`/`model()` pairs), external services (dependency lookup, now including `kafkajs`/`socket.io`/`@google/generative-ai` — §20). The chained-route/Mongoose/mount-prefix/external-services items were all real-repo-discovered gaps (§16 M3, §20 M6) — fixed same-session each time, tested against fixtures modeled on the real repos that surfaced them. Event detection (§27, 2026-08-16): Kafka produce/consume and RabbitMQ send/consume, deliberately narrower than a general event-bus detector — see §27. (`extract/interfaces.ts`) |
| Stage 4 — Structure analysis | ✅ built (`extract/structure.ts`) |
| Stage 5 — Test & environment analysis | ✅ built (§28, 2026-08-16) — `extract/environment.ts`, new `environment-setup` node type, feeds the previously-unpopulated `implementation/environment.md`. Test file inventory (count only), environment variable *names* only — never values, and a real `.env` is never opened at all (`.env.example`/`.env.sample`/`.env.template` only) — and CI/deploy config presence (GitHub Actions, GitLab CI, CircleCI, Jenkins, Docker, Docker Compose). Test *runner* identification isn't duplicated here — already a `tech-choice` node from stage 2's framework lookup (which also gained mocha/ava/tap/jasmine/cypress the same day). |
| Stage 6 — Semantic synthesis (LLM) | ✅ built (`extract/synthesize.ts`, `llm/anthropic.ts`) — proposes `requirement`/`user-flow`/`domain-concept`/`business-rule`/`invariant`/`edge-case`/`error-behavior`/`architecture-overview` nodes. Requires `ANTHROPIC_API_KEY`; skips gracefully (deterministic-only export) if unset or `--no-llm` is passed. Every claimed evidence path is checked against what was actually shown to the model (excerpt content or an observed node's evidence pointer), not the whole repo inventory — unverifiable ones are dropped and reported, weakly-grounded ones (real path, content never shown) are kept but flagged separately, not softened silently. `architecture/overview.md` narrative synthesis (§29, 2026-08-16): a new `architecture-overview` node type, capped at one per run (prompt instruction + independent code-level enforcement, same distrust-the-model discipline as evidence/supersedes verification), real-API-validated same day — see §29. **2026-08-16, first real (non-standing-in) API validation** (§16 Run 3) found and fixed three gaps in one session, each confirmed by a real API call before being traced and fixed: (1) `buildExcerpts()` silently excluded `docs/` subdirectories, (2) the file with the actual business logic was never an excerpt candidate under any selection rule (new size-based fallback added), (3) evidence verification accepted any real repo file, not just paths actually shown to the model (now tiered: excerpt-backed vs. fact-summary-only, the latter flagged as `weaklyGrounded`). Clean before/after on the same repo+model for (1)+(2): proposed nodes went from surface-level-only to correctly capturing every real business rule. |
| Stage 7 — Render & write | ✅ built (`render/render.ts`), including the secret write-gate (a real gap in it found and fixed 2026-08-16 — §23) |
| `pkr export` CLI (aliased `pkr init`) | ✅ built (`packages/cli`), flags: `--out`, `--no-llm`, `--model` |
| `pkr context` | ✅ built (`packages/core/src/context/`) — renders a single continuation-context file (`PROJECT_CONTEXT.md` / `CLAUDE_CONTEXT.md` / `AGENTS_CONTEXT.md` per `--target`) from a PKR, framed for "keep working on this existing project," not "rebuild it." Per-target content differentiation is a stub (identical facts, different filename/framing note) — real differentiation deferred until a concrete need shows up. See §17 for why this — not `pkr reconstruct` — is the primary product surface. **2026-08-16 addition** (the "agent-instruction, not a daemon" automation route, chosen over a file-watcher or git hook — see chat log rationale): the rendered file now (a) tells the agent explicitly to run `pkr update <repo>` when it finishes making changes, and (b) runs a best-effort staleness check (`--repo`, defaults to the PKR dir's parent) reusing `pkr update`'s own `diffInventory` machinery, surfacing a changed-file count or an honest "unknown" rather than silently assuming freshness. Found and fixed a real bug while verifying this live (not just via fixtures): `.context/`/`.reconstruction/` weren't in `extract/inventory.ts`'s `ALWAYS_IGNORE`, so writing a context file counted as drift against *itself* on the very next run — regression-tested in `context/index.test.ts`. |
| `pkr update` (incremental) | ✅ built (`packages/core/src/update/`) — diffs the current repo against a persisted file-hash inventory (`.knowledge/inventory.json`, new), re-runs deterministic extraction in full (cheap, no LLM) and merges the result against the stored graph by a per-type natural key (package name / title), reusing node IDs for unchanged facts and reporting a semantic diff (added/modified/removed), not a text diff. Confirmed-node protection verified end-to-end with a real bug found and fixed: the merge path was letting a confirmed node's `confirmed_by` leak onto the merged candidate, which silently defeated `FileNodeStore.upsertNode`'s protection check — now produces a `conflicts_with` edge instead (the first edge this codebase has ever produced). `--llm` re-runs stage 6 and now reconciles against existing inferred knowledge (§19, implemented 2026-08-16, motivated by a real bug found in §16 Run 4): the model is shown current inferred nodes and can mark ones it replaces via `supersedes`; `update/reconcileInferredNodes.ts` turns that into a `conflicts_with` edge (confirmed target — untouched, human resolves) or a `supersedes` edge (non-confirmed target — kept in the store, excluded from the main rendered files into a new `superseded.md`). Real-call validated same day (§19): correctly proposed the new rules and correctly superseded exactly the one stale node whose content had actually gone wrong, while leaving a related-but-still-accurate node alone. Same real call also exposed and led to fixing a second, older, unrelated bug — `knowledge-map.json` silently rendered every edge as `{}` (a `JSON.stringify` replacer-array misuse dating to M1, only ever visible once a real edge existed to render). Excerpt selection for `--llm` now prioritizes files this update's own diff found changed (§21 M7, real-repo-discovered: a genuine 12-commit Kafka feature triggered an update whose 8 excerpt slots all went to unrelated generic-orientation files — zero of the proposed nodes mentioned the feature the update was about; re-run after the fix correctly led with it). The CLI's "modified" diff line no longer collapses to `title → title` when only content or evidence changed (§22, fixed 2026-08-16) — it now reports which of `content`/`evidence` actually moved, keeping `before → after` only for genuine title changes. Knowledge Versioning (§24, auto-commit MVP, 2026-08-16): every `pkr export`/real-change `pkr update` now commits an immutable `.knowledge/versions/v0.N.yaml` snapshot (`versions.ts`) and the manifest's `knowledge_version` reflects it for real, not a hardcoded `v0.1`; `pkr log` reads the history. The full draft/commit review workflow `PKR_SPEC.md` §7 describes is still not built — see §24 for the scope decision. |
| `pkr log` | ✅ built (§24, 2026-08-16) — lists committed Knowledge Versions for a PKR (`.knowledge/versions/*.yaml`), newest first: version, timestamp, author, summary, source commit, parent. Reads only the internal store (no markdown-fallback portability — an unbuilt PKR predating this feature just reports "no versions yet"). |
| `pkr diff <from> [to]` | ✅ built (§24, 2026-08-16) — a `git log from..to`-style range over committed versions (aggregates every `changed_nodes` entry from every version strictly after `from` up to and including `to`), not a computed before/after content diff. `to` defaults to the latest version. Only supports a straight ancestor chain (no branching in this data model) — a reversed or unrelated range fails cleanly with a hint rather than silently walking the wrong chain. |
| `pkr confirm` / `pkr edit` | ✅ built (§26, 2026-08-16) — `packages/core/src/correct.ts`. The first user-facing way to actually *create* a confirmed node — the confirmed-node-protection mechanism (PKR_SPEC.md §4.2) had been validated exhaustively (§16 Run 4, §19, the mergeNodes confirmed-node-leak regression) with zero CLI surface to produce one; every prior confirmed node in this project's history was built by a test writing to the store directly. `pkr confirm <id>` confirms as-is; `pkr edit <id> --title/--content` corrects and confirms in one step (PRODUCT_SPEC.md §5.5 treats these as one feature). Commits a Knowledge Version with `author: "human"` (the first non-extractor-authored version) and a new `"confirmed"` `ChangeKind`. Verified live, not just by test: confirming a node, then changing the underlying code and running `pkr update`, correctly produced a `conflicts_with` edge (`! ... is confirmed but extraction now disagrees`) instead of a silent rewrite — the first time this exact mechanism has been exercised through real CLI usage rather than a test forcing a node into `confirmed` state programmatically. |
| `pkr reconstruct` (M2) | ✅ built (`packages/core/src/reconstruct/`) — loads a `.projectknowledge/` dir (internal `.knowledge/*.jsonl` store, or a markdown-fallback parser when that store isn't present — PKR_SPEC.md §8 portability, verified byte-identical output both ways), computes a phase-order build order (currently pure phase-order — no edges exist yet to topo-sort within a phase), and renders `.reconstruction/{SYSTEM_PROMPT,BUILD_ORDER,CONSTRAINTS,ACCEPTANCE_TESTS,CONTEXT,KNOWN_AMBIGUITIES}.md`. No LLM call. `ACCEPTANCE_TESTS.md` now pulls real `npm run build`/`test` commands (stage 2 extracts them from `package.json` scripts) plus expected endpoints/tables straight from extracted nodes. |
| Automated test suite | ✅ built. `packages/core` (vitest): 105 tests / 16 files (includes 5 covering §20's router mount-prefix resolution, 3 covering its external-services lookup-table fix, and 3 covering §21's changed-file excerpt priority, each reproducing the exact real-repo gap that motivated it), all deterministic (no network, no LLM, tmpdir-isolated fixtures — nothing touches the real repo tree). Covers: node-factory's schema-boundary enforcement (status/confidence/evidence rules), `IdAllocator` sequencing and 4-digit rollover, `FileNodeStore`'s confirmed-node protection (upsert + delete), the secret write-gate, `computeAchievableLevel`'s threshold behavior (including level 4 now being a genuinely reachable, distinct output), `naturalKey`/`diffInventory`, `pkr update --llm`'s failure-doesn't-forfeit-a-retry behavior, stage 3's route/schema detectors (`extract/interfaces.ts` — including the two M3-fixed gaps below), stage 6's excerpt-selection heuristic, evidence-grounding tiers, and §19 reconciliation (`extract/synthesize.ts` — via a no-op/fake LLM so these run free), `update/reconcileInferredNodes.ts`'s confirmed/non-confirmed split, and `supersede.ts`'s exclusion logic exercised across all three render paths (`render.ts`'s `superseded.md`, `pkr context`, `pkr reconstruct` — each with its own regression test reproducing the literal $500-next-to-$1,000 contradiction), `pkr context`'s staleness check (including the `.context`-counts-as-its-own-drift regression below), and — the highest-value additions — a `mergeNodes` regression test that reintroduces the confirmed-node-leak bug found this session and confirms it's caught (verified by hand: reverting the fix makes exactly those 2 tests fail, nothing else), a full `pkr export` → `pkr update` integration test (no-op, real change, confirmed-conflict, and the §19/Run-4 reconciliation scenario end-to-end), and a `loadPkr` jsonl-vs-markdown-fallback parity test. `packages/cli` (vitest, added 2026-08-16): 13 tests, spawns the real compiled `bin/pkr.js` as a subprocess — the one surface the core-level tests never touch. Found by actually running the CLI the way a first-time user would (bad paths, no PKR yet, typos): every single error case crashed with a raw, uncaught Node.js stack trace pointing into compiled `dist/` files instead of the clean, already-well-written `Error` message underneath — `program.parseAsync(...)` had no top-level `.catch()`, so any action handler's rejection reached the runtime uncaught. Fixed with one central handler (clean `Error: <message>`, `process.exitCode = 1`, full stack still available behind `PKR_DEBUG=1`) rather than wrapping each of the 4 commands' actions individually — same "fix it where it actually reaches the user, once, consistently" lesson as the superseded-node fix above. Regression-tested (reverting reproduces the exact crash-with-stack-trace symptom for all 4 commands, confirmed by hand) alongside baseline commander-dispatch coverage and a real end-to-end `export`/`init` happy-path smoke test. Plus 2 tests added 2026-08-16 (§22) reproducing the `title → title` modified-line bug (an Express route's line shifting without its signature changing, and a `dependency` node's genuine version-bump retitle) — reverting the fix reproduces the exact symptom and fails only the first of those two. Plus 3 tests added 2026-08-16 (§23) reproducing the secret write-gate's `\b`-boundary gap. Plus 11 tests added 2026-08-16 (§24 Knowledge Versioning): 8 unit tests on `versions.ts` (`packages/core`), 3 end-to-end integration tests (`update/index.integration.test.ts` — export commits v0.1, a no-op commits nothing, a real change commits v0.2 chained to v0.1 with the manifest reflecting it), and 4 CLI-level tests (`packages/cli` — export reports v0.1, `pkr log` shows it newest-first, a real update bumps to v0.2, a no-op update stays at v0.1, plus the clean-error case for `pkr log` with no PKR); the empty-changed-nodes guard was verified by hand (reverting it turns the one dedicated "writes nothing" unit test red, nothing else). Plus 11 more tests added the same day for `pkr diff` (§24): 6 unit (`versions.ts` — range aggregation, `to`-defaulting, identical-versions no-op, reversed-range/unknown-version errors, empty-store error) and 5 CLI (`packages/cli`, including both error cases end-to-end); the ancestor-chain guard was verified by hand (disabling it turns exactly the reversed-range test red, nothing else). Plus 14 tests added the same day for `pkr compare` (§25): 10 unit (`compare/index.ts` — perfect/partial API match, not-measurable with no endpoints, architecture always heuristic, build skipped-by-default message, build not-measurable with no build script even under `--run-build`, build actually executed both succeeding and failing with output detail, equal-weighted overall score over only scored rows, clean error for a nonexistent reconstruction path) and 4 CLI; the not-measurable guard was verified by hand. Plus 13 tests added the same day for `pkr confirm`/`pkr edit` (§26): 7 unit (`correct.ts` — confirms unchanged, edits title/content and confirms, persists across a fresh store load, re-confirm reports `wasAlreadyConfirmed`, commits a `human`-authored version with a `"confirmed"` ChangeKind, clean errors for an unknown node ID and a missing PKR) and 6 CLI (`packages/cli`, including the no-internal-store and edit-with-no-flags clean-error cases); the `confirmed_by: "human"` assignment was verified by hand — reverting it to `null` reproduces a real `ConfirmedNodeOverwriteError` on re-confirm, the same protection mechanism `mergeNodes` was already tested against, now proven to interact correctly with this new write path too. Plus 12 tests added 2026-08-16 covering two previously-tracked gaps closed the same day: stage 4/`structure.ts` (§0's own "not yet covered" note, below) — 12 unit tests on `analyzeStructure` (component-per-directory, root-level files correctly produce no component, co-located vs. dedicated test-directory convention detection, alphabetical sort, always `observed`/null-confidence) — and event detection (§27) — 8 unit tests on `analyzeEvents` (Kafka produce/consume via a required `topic:` key, explicitly confirming a bare `res.send()`/RxJS `.subscribe()` do NOT false-positive, RabbitMQ send/consume, cross-file de-dupe, real line-number evidence); the `topic:`-key guard was verified by hand — removing it doesn't just weaken precision, it crashes (a null-dereference on the now-unconditional match), an even stronger signal the guard is load-bearing. Plus 14 tests added the same day for stage 5 (§28): `extract/environment.test.ts` (new, 14 tests) — test-file-count reporting, `process.env.NAME`/`process.env['NAME']` detection, `.env.example` var-name scanning, CI/deploy marker detection per platform, always `observed`/non-empty-evidence. Two tests specifically prove the security property is real, not just regex-shaped: one that a name existing *only* in a real `.env` never appears anywhere in output (proves the file is never opened at all, not just that its value would be discarded), one that a value from `.env.example` never appears even though its key does. The filename-restriction guard was verified by hand in an unusually convincing way: the first version of that "never opens .env" test actually passed even with the guard deliberately broken, because the value-discarding regex made the test's original assertion (checking a secret *value* never leaked) true regardless of which files got scanned — rewritten to check that a name unique to `.env` never appears at all, which then correctly failed against the broken guard (and the failure output showed the leaked node in full, `.env` visibly having been read) and passed once restored. Plus 4 tests added the same day for `architecture-overview` synthesis (§29): accepts a single evidence-grounded node like any other type, a REGRESSION test proving the code-level at-most-one enforcement actually fires (not just the prompt instruction — two candidates in one fake-LLM response, only the first kept, the second lands in `skipped` with a specific reason), and confirming the same evidence-verification/rejection path applies to this type as every other, plus 1 render-level test confirming it lands in `architecture/overview.md`, the file that existed in the schema but sat empty since early in the project. `packages/core` total now 180 tests / 22 files; **211 across both packages** (`packages/cli`: 31 tests). Stage 4 is now covered directly — the "not yet covered" gap this row used to end on is closed. |
| `pkr compare` | ✅ built (§25, 2026-08-16), MVP scope — `packages/core/src/compare/`. Compares an original PKR against a candidate reconstruction repo: API/schema compatibility (measured, name-set diffs), architecture similarity (heuristic, Jaccard over component names), build/test success (measured, opt-in via `--run-build` — the only subprocess call in this codebase that runs code from something other than this tool itself). Every row explicitly labeled measured/heuristic/not-measurable, overall score is a printed equal-weighted average, never a black box. Deferred: shape/column-level schema diff, black-box contract-test execution of the original's suite against the reconstruction, compound "behavioral similarity". |
| Hosted platform (M6+) | ❌ not built, by design (§7) |

Validated end-to-end against: this repo, `packages/core` standalone, a cloned copy
of `expressjs/express`, a small fixture repo exercising Prisma + Stripe/Postgres
dependency detection + Express routes, and (live, real API key, user-supplied)
`claude-sonnet-5` synthesizing this repo's own `product/`/`behavior/` layers —
15 proposed nodes, 0 dropped, confidence honestly varied 0.60–0.90. See §16 for
two full M3 loop runs (export → reconstruction → blind agent): a real external
repo (Run 1, contamination-limited) and a synthetic fixture built specifically
to test whether a deliberately asymmetric business rule survives reconstruction
(Run 2 — it did). See §30 for a full-cycle validation of the entire §24-29
surface together (Versioning, diff, compare, confirm/edit, event detection,
stage 5, architecture-overview) against a real, large, unfamiliar repo
(`thisisdkyadav/hostel-management-system-backend`, 533 source files, 677
nodes, 5 real chained Knowledge Versions) — clean, zero new bugs found.

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

## 20. M6 — first difficult, realistic test: a real, obscure, unfamiliar repo at real scale

Every prior run either used a small (~10-file) synthetic fixture or one real
repo popular enough to risk training-data contamination (§16 Run 1). Neither
tests what happens at real scale, on a repo genuinely never seen before.
Chose `SB2318/ultimatehealth-backend` (3 stars, not a fork, verified via the
GitHub API before cloning) specifically for size and mess: 125 real source
files, 30 model files, 21 route files, a real mixed/messy dependency list
(Express + Mongoose *and* an unused `@prisma/client` leftover, AWS S3,
Firebase Admin, Kafka, Socket.io, Google Generative AI) — the kind of
accumulated real-world complexity no fixture built to exercise our own
regexes would ever produce.

**Confirmed working at scale:** deterministic extraction produced 300 nodes
(29 of 30 real Mongoose models correctly detected) in well under a second of
CPU time. No secrets were present in the repo to redact, so the write-gate
wasn't exercised either way here.

**New finding — real data loss, not cosmetic (found by reading the actual
mount setup, not by a test failing):** `analyzeApiEndpoints` extracted every
route file's paths in total isolation, with zero awareness that
`app.use('/api/gemini', aiRoute)` in the entry point prefixes everything
inside it. `router.get('/:id', ...)` is an extremely common pattern across
independently-written route files — on this repo, 4 (method, path) pairs
were byte-identical across *different* route files mounted at *different*
real prefixes (`PUT /:id` ×2, `POST /` ×2, `GET /` ×2, `DELETE /:id` ×2).
The existing (method, path)-only de-dupe key (`extract/interfaces.ts`) kept
only the first evidence location for each — the second, genuinely distinct,
real endpoint silently vanished from the PKR. Not hypothetical: verified by
grepping the raw route files directly and confirming which pairs actually
collided before touching any code.

**Fixed same session** — single-level router mount-prefix resolution, added
to `extract/interfaces.ts`: scans every source file for `<app|router>.use(
'<literal-prefix>', <identifier>)` calls, resolves `<identifier>` back to a
file via that same file's own `require`/`import` bindings (CommonJS and ES
module default-import forms both handled), and prepends the resolved prefix
to every route found in that file. A file with no resolvable mount falls
back to the old prefix-less behavior unchanged — the fix can only ever add
information, never remove a route that was already being found, which kept
all 99 pre-existing tests passing unmodified. Explicitly **not** attempted:
composing prefixes through multiple layers of nested/re-exported routers
(a router mounted under a router that's itself mounted elsewhere) — that
needs transitive graph resolution, a bigger undertaking, and this repo's own
mounting pattern (every route file mounted directly from the entry point)
didn't need it to fix the actual bug found.

**Re-ran the real export after the fix:** `api-contracts.md` went from 181
to 187 endpoints (the 6 that were being silently eaten), and paths that used
to read as bare, ambiguous `/:id` now read as the real, distinct
`/api/glossary/:id` / `/api/language/:id` / etc. Specifically re-verified
all 4 originally-colliding pairs are now two distinct, correctly-prefixed
nodes each. 5 new tests in `interfaces.test.ts` (the exact collision
scenario reproduced and fixed; ES-module import resolution; graceful
fallback with no mount found; not mistaking `app.use(cors(...))` for a
router mount; a router legitimately mounted under two different prefixes
emitting two nodes) — each verified by hand to regress into the original
collision when the fix is reverted.

**Minor finding — fixed same day.** `KNOWN_EXTERNAL_SERVICES`
(`extract/interfaces.ts`) correctly listed this repo's AWS S3, Firebase
Admin, and Nodemailer as `external-service` nodes, but missed `kafkajs`,
`socket.io`, and `@google/generative-ai` — all three were still correctly
captured as plain `dependency` nodes, just not elevated to the more
semantic `external-service` type (no information lost, just
under-classified — deprioritized behind the mount-prefix fix above for that
reason). Added all three (`"Kafka (via KafkaJS)"`, `"Socket.IO"`,
`"Google Generative AI (Gemini)"`) to the lookup table. 3 new tests in
`interfaces.test.ts` — a baseline case (existing entries still resolve), the
regression case (all three new ones resolve, reverting the addition
reproduces exactly 2-of-3 going missing again, confirmed by hand — the third
had been added in a different spot in the table and survived a partial
revert, which is itself a small useful confirmation that the test was
actually checking real map contents and not a stale expectation), and an
unknown-package-name case (no error, empty result).

**What this run does and doesn't prove:** real, positive evidence that the
deterministic layer holds up on a genuinely messy, unfamiliar, real-scale
repo — and that testing at real difficulty finds real bugs a clean fixture
never would (the mount-prefix bug specifically requires *multiple*
independently-written route files sharing a path, which no single
hand-built fixture in this project had ever exercised). Did not re-run
stage 6 after the extraction fix on this specific repo (would cost another
real call for marginal additional signal beyond what §16 Run 3/Run 5 already
established about stage 6 quality) — the fix and its evidence are entirely
in the deterministic layer, verified directly by inspecting the rendered
output, not by trusting a model's summary of it.

## 21. M7 — `pkr update --llm` against real, unscripted git history

Every prior `pkr update --llm` run (§16 Run 4, §19's real-call validation)
used code changes I wrote myself to exercise a specific mechanism. Never
once tested against a genuine, organic commit sequence nobody scripted for
this project's benefit — the actual real-world shape of "an agent or
developer did real work, now sync." Re-used the same `ultimatehealth-backend`
repo from M6, this time cloned with full history: `pkr export` at a real
commit (`72b2199`), then `git checkout` 12 real commits forward to the
actual tip of the repo's `main` branch (`7fa2299`, timestamped literally
hours before this test — the repo was under active real development *during
this session*), then `pkr update --llm`. Those 12 commits were a genuine
feature: introducing a Kafka producer/consumer event system (dead-letter
queue, analytics/notification/email consumers, `docker-compose.yml`
changes) — 23 real changed files, found via `git diff --name-only` between
the two commits, not curated for this test.

**Deterministic layer: correct, unremarkable.** `+11 ~13` files detected
correctly; zero new deterministic facts (no new routes/models in the changed
files — genuinely correct, these commits added service/infra code, not new
API surface).

**Stage 6: the update completely missed the actual point of the update.**
The 12 commits were unambiguously *about* the new Kafka architecture. None
of the 7 nodes stage 6 proposed mentioned it. Root cause, confirmed by
reading the code rather than guessing: `buildExcerpts()` reruns the exact
same generic "orient a stranger to this whole repo" selection
(README/docs/API-evidence/entry-points/largest-file) on every `pkr update`
call, with **zero awareness of the file diff that triggered the call in the
first place** — `synthesizeProductAndBehavior` was never even given the
changed-file list to begin with. On a repo already large enough to blow past
`MAX_EXCERPT_FILES(8)` on its general-orientation files alone (M6 already
showed 58% weakly-grounded at this repo's scale), none of the 23 genuinely
relevant files ever had a chance to be selected.

**Fixed same session.** `synthesizeProductAndBehavior` gains a `changedFiles`
parameter (defaults to `[]` — nothing has "changed" on a first `pkr
export`); `update/index.ts` passes `[...fileDiff.added, ...fileDiff.modified]`.
`buildExcerpts()` tries these *first*, sorted by size (same "biggest file
= probably the real logic" heuristic as the existing size-based fallback),
deliberately ahead of README/docs — an update call already gets project
orientation from the `<observed_facts>`/`<existing_knowledge>` blocks, so
the excerpt budget is better spent on what's actually new. 3 new tests in
`synthesize.test.ts` (priority wins under a full budget; without
`changedFiles` the same small file loses to the size fallback, confirming
this is genuinely additive not a general size-rule change; a stale changed-
path that no longer exists is ignored, not an error) — reverting reproduces
the exact real symptom (the file is excluded again), confirmed by hand.

**Re-ran the exact same real call after the fix, same two commits, same
model:** the *first* proposed node was `REQ-INFRA-001`, *"Event-driven
architecture via Kafka for emails, analytics, and notifications"* — the
actual point of the update. 14 nodes total (up from 7), most of the rest
correctly describing real business rules from the *other* files this diff
also touched (several controllers were modified to wire up the new Kafka
publishing) — not just "found Kafka," but a broader, correct improvement:
prioritizing what genuinely changed surfaced real logic across the board,
not one narrow topic.

**Second, smaller finding from the same run, fixed 2026-08-16 (§22):** the
CLI's "modified" diff lines print `before.title → after.title`
(`update/index.ts`/`packages/cli/src/index.ts`). When a fact's *content*
changes but its title doesn't (very common — e.g. `ARCH-STRUCT-007`
"services/" component's file count changed after 11 new files landed in
it), the line reads `services/ → services/`: technically accurate, tells a
human reading the diff nothing about what actually changed. A real,
observed UX gap, not hypothetical — deprioritized behind the excerpt-
priority fix above (that one was silently missing the entire point of an
update; this one is a diff that's honest but unhelpfully terse).

**What this run does and doesn't prove:** the clearest evidence yet that
this session's discipline — test against real, unscripted conditions, not
just fixtures built to exercise known code paths — keeps finding bugs that
fixtures structurally cannot, because a fixture is, by construction, never
bigger or messier than whatever it was built to test. Every real-repo run
this session (§16 M3, §20 M6, this one) has found something a synthetic
fixture didn't, and each was in a different subsystem (extraction,
rendering, excerpt selection twice). Not a coincidence to keep expecting:
the fixtures this project's own test suite uses are necessarily bounded by
what was already known to matter when they were written.

## 22. Fix: `pkr update`'s "modified" line reports what actually changed

Closes the §21 finding above. `mergeDeterministicNodes`'s `contentEquivalent`
check (`update/mergeNodes.ts`) already guarantees a node only lands in
`report.modified` when at least one of `title`/`content`/`evidence` genuinely
differs — the CLI just wasn't looking past `title`. New
`describeNodeModification(before, after)` in `packages/cli/src/index.ts`:
if the title itself changed, keeps the familiar `before → after` (still the
clearest form for that case — e.g. a `dependency` node's version-range
title); otherwise reports which of `content`/`evidence` changed, e.g.
`services/ (content changed)` or `GET /status (evidence changed)`.

Two CLI-level regression tests added (`packages/cli/src/index.test.ts`,
spawning the real compiled binary — same discipline as the rest of that
suite), each reproducing a real code shape rather than a synthetic diff:

- an Express route whose line number shifts (a comment inserted above it)
  without its method or path changing — title and content stay identical,
  only `evidence` (the line number) moves. Confirms the line now reads
  `GET /status (evidence changed)`, not `GET /status → GET /status`.
- a `dependency` node's version bump (`express (^4.18.0)` → `express
  (^4.19.0)`) — a genuine title change (natural-key matching still treats it
  as the same fact, stripping the version for identity purposes per
  `naturalKey.ts`). Confirms the `before → after` form is still used here,
  so the fix doesn't regress the one case where an identical-looking title
  pair would actually be wrong to suppress.

Verified by hand: reverting `describeNodeModification`'s call site back to
`before.title → after.title` reproduces the exact `GET /status → GET
/status` symptom and fails exactly that one test — the title-change test
still passes unchanged, confirming it wasn't accidentally the same
assertion in disguise. Full suite: 105 core + 13 CLI = 118 tests, all
passing.

No other render path had the same bug — `render.ts`'s `superseded.md` and
stage 6's `superseded`/`conflicts` CLI output already print the old and new
node's titles as two separate, clearly-labeled lines rather than diffing
them into one, so they were never at risk of collapsing to `X → X`.

## 23. Security / performance / quality self-review (2026-08-16)

Requested directly, not tied to a specific bug report: read through the
security-critical and highest-traffic paths deliberately looking for
problems, rather than waiting for another real-repo run to surface one.
Checked, in order: the secret write-gate, prompt-injection defenses,
shell/process invocation, file-path construction, `npm audit`, LLM
token/cost budgeting, and general type-safety hygiene (`as any`,
`@ts-ignore`, stray `TODO`s).

### Found and fixed: secret write-gate missed the most common real .env shape

`secrets.ts`'s generic fallback pattern (for secrets with no fixed value
shape — unlike AWS/GitHub/Stripe/Slack/Google keys, which are still caught
by their own value-shape regexes regardless of this bug) required a regex
word-boundary (`\b`) immediately before the keyword (`secret`, `token`,
`api_key`, `password`, `passwd`, `pwd`). `\b` only fires between a "word"
character and a non-word one — and `_` and a lower→upper case transition
both still count as "word" to `\b`. Net effect: it caught a *bare*
`API_KEY=...` or `password: "..."` but silently let through any prefixed
compound identifier, which is how most real `.env` files and config objects
actually name things:

```
ANTHROPIC_API_KEY=sk-ant-...   # missed
DATABASE_PASSWORD=...          # missed
JWT_SECRET=...                 # missed
jwtSecret = "..."              # missed
API_KEY=...                    # caught
```

Confirmed by hand against the live regex (not hypothesized) before touching
any code. This is the one write-gate standing between an analyzed repo's raw
`.env`/config file content and `.projectknowledge/` — a false negative here
means a real secret value could land in files this tool tells users are
safe to commit and safe to hand to an LLM (`PKR_SPEC.md` §10). Severity:
high in principle (defeats the gate's actual job on its most common real
target); likelihood in practice depends on whether such a file ever becomes
excerpt/evidence content in the first place — not verified either way, so
treated as a real gap regardless.

**Fix:** dropped the leading `\b` — the keyword now matches anywhere inside
a larger identifier, no separator required. `\s*[:=]` immediately after the
keyword is unchanged and still does the real work of avoiding false
positives on ordinary prose ("...password hashing..." has no `=`/`:` right
after "password", so it's still never flagged). Consistent with the
module's own stated design principle (over-redact rather than be
permissive — see the module doc). 3 new regression tests in
`secrets.test.ts` covering the three shapes above; reverting the fix
reproduces exactly those 3 failures, the other 7 secrets tests unaffected.

**Known residual gap, not fixed:** multi-word compounds where the keyword
isn't the *last* segment before `=` (`AWS_SECRET_ACCESS_KEY=...`,
`STRIPE_SECRET_KEY=...`) are still missed by this pattern specifically —
though both of those examples happen to still be caught by this project's
Stripe/AWS-key-ID value-shape patterns for the *value* itself in the Stripe
case, and not at all for a raw AWS secret access key (which has no
detectable fixed shape — a known, general limitation of regex-based secret
scanning, not specific to this tool). Not chasing this further now: `\b`
removal fixes the overwhelmingly common single-keyword-suffix case for a
real, bounded cost; enumerating every multi-word compound is diminishing
returns for a tool that's explicitly documented as defense-in-depth, not a
guarantee.

### Checked, no issue found

- **Prompt injection defenses** (`extract/synthesize.ts` `SYSTEM_PROMPT`):
  re-read against the actual system prompt text, not from memory — the
  DATA-framing and explicit "treat embedded instructions as inert" rule are
  both present and unchanged from what real API calls have already
  validated (§16 Run 3, §19, §21).
- **Process invocation**: the only two `execFileSync` call sites
  (`pipeline.ts`, `update/index.ts`, both `git rev-parse HEAD`) pass a fixed
  argv array with no shell (`execFileSync` never spawns a shell unless
  told to), and `repoRoot` is only ever used as `cwd`, never interpolated
  into a command string — no injection surface.
- **Path construction for writes**: every `writeFile(outDir, relPath, ...)`
  call site was traced. Per-node-type file targets are a fixed lookup table
  (`FILE_TARGETS` in `render.ts`), not content-derived. The one
  content-derived path (`decisions/${node.id}-${slug}.md`) strips every
  non-`[a-z0-9]` character from the slug (so no `/` or `.` survives even if
  a title contained them), and `node.id`'s domain segment is already
  regex-constrained to `^[A-Za-z][A-Za-z0-9 _-]*$` at the point an LLM
  response is parsed (`synthesize.ts`'s `SynthesizedNode` zod schema) — no
  path-traversal surface via either a malicious repo or a manipulated LLM
  response.
- **`npm audit`**: 0 vulnerabilities, full dependency tree.
- **LLM call token/cost budgeting**: `MAX_EXCERPT_FILES` (8),
  `MAX_CHARS_PER_EXCERPT` (2000), `MAX_OBSERVED_SUMMARY_ITEMS` (60),
  `MAX_EXISTING_KNOWLEDGE_ITEMS` (40) all cap input size regardless of repo
  size — cost doesn't scale unboundedly with a large repo. Output
  `maxTokens: 12000` (not the client default of 4096) is already sized for
  the realistic worst case (up to 40 nodes), a deliberate choice per the
  comment already in `synthesize.ts` — checked it was actually a real,
  documented decision and not an oversight.
- **Type-safety hygiene**: zero `as any`, `@ts-ignore`, `@ts-expect-error`,
  or `eslint-disable` anywhere in `packages/core/src` or `packages/cli/src`
  (excluding tests). Zero stray `TODO`/`FIXME`/`XXX` markers.
- **Storage-layer performance** (`FileNodeStore`): loads/writes the full
  node and edge sets on every `pkr export`/`update` call, `O(n log n)` on
  every `listNodes()`/`save()` call from re-sorting by ID. Fine at the scale
  this tool operates at today (single-repo PKRs, realistically hundreds to
  low thousands of nodes); would need a real index if a PKR ever grew to
  tens of thousands of nodes. Noted, not acted on — no evidence this is
  close to mattering yet, and premature indexing here would just be
  unvalidated complexity.

### What this review does and doesn't establish

Found one real, fixed bug in a security-critical path by deliberately
reading the code adversarially rather than waiting for another real-repo
run to trip over it — a different discovery method than every other
finding this session, and it worked. It does not substitute for another
round of real-repo testing (§16, §20, §21's own lesson: fixtures and
read-throughs structurally can't find what real scale/mess finds) — it's a
complementary check, not a replacement for one.

## 24. Knowledge Versioning — auto-commit MVP (2026-08-16)

`PKR_SPEC.md` §7 already specs a real design: an immutable
`.knowledge/versions/v0.N.yaml` snapshot per commit, chained by
`parent_version`, with `changed_nodes`, `summary`, `reason`,
`source_commit`. What it also specs — and what this slice deliberately
does *not* build — is a draft/commit review step: `pkr update` proposing a
draft that only becomes real once a human runs `pkr commit`. Building that
would mean a new draft-vs-committed state machine sitting in front of
`pkr update`'s direct-apply behavior, which is exactly the part of this
codebase §16 through §22 spent the most effort validating against real
conditions. Retrofitting a staging layer under it now would be a much
larger, riskier change than versioning the *result* of an update — so this
slice does the latter only, and says so everywhere the gap matters
(`versions.ts`'s module doc, `PKR_SPEC.md` §7's new implementation note).

### What ships

- **`versions.ts`** (new): `commitVersion(knowledgeDir, {summary, changedNodes,
  sourceCommit, reason?})` writes the next `v0.N.yaml` and returns its
  version string — or writes nothing and returns `null` if `changedNodes`
  is empty, because a version with no real knowledge change isn't a real
  commit. `listVersions()` reads them back, oldest first, by scanning
  `.knowledge/versions/` itself rather than a separate counter file — the
  same reasoning that already makes `nodes.jsonl` the source of truth
  instead of a cache: versions are an append-only log, so the log itself is
  the state. `summarizeChanges()` turns a `ChangedNode[]` into a one-line
  summary (`+3, ~1, 1 superseded`).
- **`pipeline.ts` (`pkr export`)**: always commits `v0.1` unconditionally —
  export is always a full clean rebuild (module doc), so every node it
  produces is genuinely new for this PKR's history, `parent_version: null`.
- **`update/index.ts` (`pkr update`)**: commits the next version only when
  `changed_nodes` would be non-empty — built from `nodeMerge`
  (added/modified/removed/conflicts) plus, only if stage 6 actually ran and
  succeeded, `llmReport` (added/superseded/conflicts). A file that changed
  but produced zero fact-level movement (e.g. two files touched but only
  one affected an extracted fact) correctly commits nothing — verified live
  against a real fixture, not just asserted: a comment-only edit that
  didn't shift any evidence line produced no new version, while a change
  that *did* shift a route's line number (§22's own regression scenario)
  correctly did, with `~ ... (evidence changed)` as the changed-node
  reason. A failed `--llm` call contributes nothing to `changed_nodes`,
  consistent with §16 Run 4's "a failed call must never silently advance
  state" fix — deterministic changes still commit; the LLM's contribution
  simply isn't there to commit.
- **`author`** is always `extractor:pkr-cli@0.1.0` — there's no
  `pkr confirm`/`pkr edit` yet (PKR_SPEC.md §8 already describes them, not
  built — ARCHITECTURE.md §0) to attribute a version to a specific human,
  and `reason` is omitted rather than fabricated (a "reason" implies human
  intent that doesn't exist yet for an auto-commit).
- **`pkr log <pkr-dir>`** (new CLI command): lists committed versions,
  newest first — version, timestamp, author, summary, source commit,
  parent. Both `pkr export` and `pkr update`'s own output now report the
  version they just committed (or, for `update`, that nothing was
  committed and why).
- **`manifest.yaml`'s `knowledge_version`** is now the real committed
  version on every render, not the hardcoded `"v0.1"` string every prior
  render wrote regardless of history.

### Verified live, not just by unit test

Ran the real compiled CLI end-to-end against a fresh fixture repo:
`export` → `v0.1` (2 nodes, both `added`) → add a route, `update` → `v0.2`
(chained to `v0.1`, `+1`) → `pkr log` shows both, newest first, with real
`source_commit` SHAs from the fixture's own git history → a line-shifting
comment-only edit correctly produced `v0.3` (both existing routes'
`evidence` genuinely moved) rather than silently skipping a real change or
inventing a version for a no-op.

### Testing

8 unit tests on `versions.ts` (numbering, chaining, the empty-changed-nodes
no-op guard — verified by hand: removing the guard turns exactly that one
test red, nothing else — auto-authorship, omitted `reason`), 3 end-to-end
integration tests in `update/index.integration.test.ts`, and 4 CLI-level
tests spawning the real compiled binary (`packages/cli`). `packages/core`:
119 tests / 17 files. Both packages: 136 tests.

### `pkr diff` (added same day, straight after this)

The `changed_nodes` ledger each version already carries turned out to be
enough to answer "what changed between two versions" without any new data
— `diffVersions(knowledgeDir, from, to?)` walks `parent_version` back from
`to` (default: the latest committed version) until it reaches `from`,
concatenating every version's `changed_nodes` along the way, oldest first.
Deliberately a `git log from..to`-style *range* over the commit ledger, not
a computed before/after content diff — a node touched twice in the range
appears twice, not netted into one line, because netting it honestly would
mean comparing actual node content across versions, a materially bigger
feature this slice doesn't need yet. Only supports a straight ancestor
chain (no branching exists in this data model — ARCHITECTURE.md §15 rules
branch-like versions out at the product level too); a reversed or
unrelated range throws a clear error instead of silently walking the wrong
chain, with a "did you mean...?" hint when the version numbers alone
suggest the pair was just given backwards. 6 more unit tests (aggregation
across a multi-version range, `to` defaulting, identical-versions no-op,
reversed-range and unknown-version error messages, empty-store error), 5
more CLI tests (including both error cases end-to-end, asserting the same
"no stack trace" discipline as every other CLI error path). Verified live
against a real 3-commit fixture (`v0.1`→`v0.2`→`v0.3`, one route added per
commit): `pkr diff v0.1 v0.3` correctly listed both additions grouped by
version with the right summary; `pkr diff v0.3 v0.1` correctly failed with
the reversed-range hint. `packages/core`: 125 tests / 17 files. Both
packages: **147 tests**.

### Explicitly deferred

The draft/commit review step (PKR_SPEC.md §7's actual full design) and a
real `pkr commit`/`pkr confirm`/`pkr edit` human-correction workflow. Not
abandoned — §7's spec text still describes the target shape — scoped out
of this slice for the reason above, not overlooked.

## 25. `pkr compare` — MVP scope (2026-08-16)

The full §5 table specs six dimensions, two of which are structurally
bigger than a single slice: "test compatibility" as originally scoped means
running the *original's* test suite against the reconstruction, which
needs contract-test detection (which black-box tests even apply across two
different codebases?) that doesn't exist; "behavioral similarity" is an
explicit rollup of everything else, better built once the rows under it are
validated against something real. Both deferred outright, not faked.

### What ships

- **`compare/index.ts`** (new): `runCompare({originalPkrDir,
  reconstructionRepoDir, runBuild?})`. Loads the original via the existing
  `loadPkr()` (jsonl-or-markdown-fallback, same loader `pkr reconstruct`
  already uses); runs a *fresh* deterministic extraction pass against the
  reconstruction repo using the same extractors as everywhere else
  (`analyzeApiEndpoints`, `analyzeDatabaseSchema`, `analyzeStructure`) —
  same "re-extract with a throwaway scratch allocator" pattern `pkr
  update` already established, nothing new invented for comparison
  specifically.
- **API / schema compatibility** (measured): a name-set diff — original's
  `api-endpoint`/`db-table` node titles vs. the reconstruction's freshly
  extracted ones. Score = matched / original size; missing and extra items
  both listed. Deliberately name-level only, not shape/column-level — that
  would mean parsing structured detail back out of free-text `content`
  (fragile), a real simplification, stated as one, not silently assumed
  precise.
- **Architecture similarity** (heuristic, always labeled as such): Jaccard
  similarity of `component` node title sets (directory-derived, from
  `structure.ts`).
- **Build / test success** (measured, may be not-measurable, opt-in): the
  only genuinely new category of capability in this codebase — actually
  executing `npm run build`/`npm test` inside the reconstruction directory
  via `execFileSync`. Every other subprocess call anywhere in this project
  is a fixed `git rev-parse HEAD`; this is the first time pkr runs code
  that isn't itself. Gated behind `--run-build` (default off) specifically
  because of that — the CLI says exactly why when it's skipped, rather than
  silently omitting the row. When the original has no `build`/`test` script
  at all, the row is `not-measurable` regardless of the flag — there's
  nothing to compare against. `npm run <script>` is always literal, never a
  string assembled from repo content — the script *name* ("build"/"test")
  is the only variable, and it's one of two fixed literals, not a
  dynamically constructed command — so there's no command-injection surface
  beyond what `npm run build` on an untrusted repo already inherently is.
  `timeout: 120_000` so a hung build can't hang `pkr compare` forever.
- **Overall score**: equal-weighted average across every row that actually
  got a score (not-measurable rows excluded from both the average and the
  weights) — and the weights are printed in the CLI output alongside the
  score, never implied.

### Verified live against a real fixture (not just unit tests)

A 2-endpoint original vs. a reconstruction missing one endpoint and adding
an unrelated one, via the actual compiled CLI: correctly reported `1/2
reproduced, 1 extra` with both named; architecture similarity at 100%
(same single top-level directory on both sides, correctly heuristic-labeled
regardless); build skipped by default with the exact `--run-build` hint;
re-run with `--run-build` against a reconstruction whose build script
deliberately exits 1 correctly reported `Build success [measured] 0%` with
real captured npm output, and the overall score/weights recomputed to
include it once it became measurable.

### Testing

10 unit tests (`compare/index.test.ts`, `packages/core`) — perfect match,
partial match with missing/extra detail, not-measurable when the original
has no endpoints, architecture always heuristic, build skipped by default
with the right message, build not-measurable with no build script even
under `--run-build`, build actually executed and reporting both success and
failure with output detail, equal-weighted overall score computed only over
scored rows, and a clean error for a nonexistent reconstruction path. The
not-measurable guard was verified by hand (disabling it turns exactly the
one dedicated test red, nothing else). 4 CLI-level tests (`packages/cli`,
spawning the real compiled binary) covering the labeled-rows-plus-score
happy path, the build-skipped-by-default message, and both "nonexistent
reconstruction path" / "nonexistent original PKR" clean-error cases.
`packages/core`: 135 tests / 18 files. Both packages: **161 tests**.

## 26. `pkr confirm` / `pkr edit` — the missing human-correction surface (2026-08-16)

PRODUCT_SPEC.md §5.5 lists "human correction" as an MVP feature and
PKR_SPEC.md §4.2 specs confirmed-node protection in real detail — and this
session validated that protection mechanism more thoroughly than almost
anything else in the codebase (§16 Run 4's mergeNodes confirmed-node-leak
bug and its regression test, §19's reconciliation design, the `conflicts_with`
edge that mechanism produces). All of that validation used a node that was
already confirmed by direct store manipulation in a test. There was no way
for an actual human, using the actual CLI, to ever produce one. `pkr
confirm`/`pkr edit` close that gap.

### What ships

- **`correct.ts`** (new): `confirmOrEditNode({outDir, nodeId, title?,
  content?})`. Loads the node from the writable `FileNodeStore` (not the
  read-only `loadPkr()` other read paths use — this needs to write back),
  sets `status: "confirmed"`, `confidence: null`, `confirmed_by: "human"`
  unconditionally (safe on a re-confirm too — `confirmed_by` on a real
  `KnowledgeNode` is only ever `"human"` or `null`, so any node that's
  already `confirmed` could only have gotten there through this same
  function), overwrites `title`/`content` only if given, saves, commits a
  Knowledge Version, and re-renders.
- **`pkr confirm <pkr-dir> <node-id>`**: confirms as-is.
- **`pkr edit <pkr-dir> <node-id> --title <t> --content <c>`**: corrects
  and confirms in one step — requires at least one of `--title`/`--content`
  (a clean CLI-level error otherwise, not a silent no-op edit). Editing a
  fact *is* correcting it — PRODUCT_SPEC.md §5.5 treats confirm/correct as
  one feature, and there's no useful "edited but still just
  observed/inferred" state worth modeling separately.
- **A PKR with no internal `.knowledge/nodes.jsonl`** (a markdown-only,
  portability-fallback copy — PKR_SPEC.md §8) is rejected with a clear
  error rather than silently doing nothing: corrections have to land
  somewhere durable, and the markdown files are generated output, not the
  place to write them.
- **Knowledge Versioning integration** (§24): every confirm/edit commits a
  version with `author: "human"` — `commitVersion()`'s `author` input
  gained an override for this (previously always the fixed extractor
  string). New `ChangeKind: "confirmed"`, distinct from `"modified"`, so
  `pkr log`/`pkr diff` don't conflate a human correction with an ordinary
  automated re-extraction change.

### Verified live, not just by test

Exported a fixture, confirmed its one API endpoint via the real compiled
CLI (`v0.2`, `author: human`, correctly listed in `pkr log`), then changed
the underlying route in the source and ran `pkr update`: it correctly
produced `! API-HTTP-001 "GET /status" is confirmed but extraction now
disagrees — needs manual review` — a `conflicts_with` edge, not a silent
rewrite. This is the exact mechanism §16 Run 4 and every test since has
exercised, but this is the first time it happened end-to-end through real
CLI usage rather than a test forcing a node into `confirmed` state
programmatically.

### Testing

7 unit tests (`correct.ts`) and 6 CLI-level tests (`packages/cli`,
spawning the real compiled binary — including the no-internal-store and
missing-flags clean-error cases). The `confirmed_by: "human"` assignment
was verified by hand: reverting it to `null` reproduces a real
`ConfirmedNodeOverwriteError` the moment a node is re-confirmed — the same
protection error `mergeNodes` was already tested against, now proven to
interact correctly with this new write path too, not just the automated
ones. `packages/core`: 142 tests / 19 files. Both packages: **173 tests**.

## 27. Closing two tracked gaps: stage 4 test coverage, event detection (2026-08-16)

With the CLI-level MVP feature set essentially complete after §26 (every
`PRODUCT_SPEC.md` §5 feature except the hosted web app/auth, which are out
of scope by design — §7), turned to the smaller items §0 had been
carrying as known, tracked gaps rather than open-ended new features.

### Stage 4 (`structure.ts`) unit tests

Had zero direct coverage despite being exercised indirectly through every
integration test — the one specific gap the "Automated test suite" row
kept naming. `analyzeStructure` is pure metadata analysis over an
already-built `Inventory` (no file content read, no disk I/O of its own),
so the 12 new tests construct `Inventory` objects directly rather than
writing real files to disk — there's nothing content-based here that real
files would exercise differently. Covers: one component node per top-level
source-containing directory, root-level files correctly producing zero
components, the monorepo/workspace convention detector, both directions of
the co-located-vs-dedicated test convention (majority-rules), alphabetical
sort, and the blanket rule that every stage-4 node is `observed` with null
confidence (no judgment calls at this stage).

### Event detection (`analyzeEvents`, `extract/interfaces.ts`)

The one extraction category `interfaces.ts`'s own module doc had named as
"a known gap, not built yet" since early in this project. Scoped
deliberately narrower than "detect any event system": Kafka (kafkajs)
produce/consume and RabbitMQ (amqplib) send/consume only. A general
event-bus detector would mean matching `.publish()`/`.subscribe()`/`.on()`
against Node's own `EventEmitter`, RxJS, MQTT, Redis pub/sub, and any
custom pub/sub wrapper — too many unrelated, common APIs share those method
names to detect without guessing (this stage is `status: observed` only;
PKR_SPEC.md §4.1 doesn't allow it to hedge with a lower confidence
instead). The two patterns built both have a genuinely distinctive
"fingerprint": a literal `topic:` key inside a `.send(`/`.subscribe(`
call's arguments (kafkajs's actual API shape), or the much less ambiguous
method names `sendToQueue`/`consume` (amqplib). Explicitly verified the
negative case matters, not just the positive one: a plain Express
`res.send(...)` and an RxJS `.subscribe(...)` — both far more common in a
typical repo than an actual Kafka call — do not produce a false-positive
event node, because neither has a `topic:` key in its arguments.

Verified live via the compiled CLI against a real fixture combining both
protocols in one file: correctly produced 4 distinct event nodes (`Kafka
produce → order-events`, `Kafka consume ← order-events`, `RabbitMQ produce
→ notifications`, `RabbitMQ consume ← notifications`), each with correct
per-line evidence, rendered into the pre-existing (previously always empty)
`interfaces/events.md` — the `event` node type, its `EVT` ID prefix, and
its render target already existed in the schema/render layer from early in
the project; this is the first extractor that ever actually populates it.
Wired into both `pkr export` (`pipeline.ts`) and `pkr update`
(`update/index.ts`) the same way every other stage-3 extractor is; `event`
was already in `naturalKey.ts`'s `NATURAL_KEY_TYPES`, so incremental update
matching for event nodes works without any additional change.

### Testing

8 unit tests (`extract/interfaces.test.ts`) for events, 12 for
`structure.ts` (`extract/structure.test.ts`, new file). The `topic:`-key
guard was verified by hand in an unusually strong way: removing it doesn't
just weaken precision on the false-positive tests, it crashes outright (a
null-dereference on what's now an unconditional regex-match access) —
about as unambiguous a signal as a revert-and-check can produce that a
guard is load-bearing rather than defensive-but-unnecessary.
`packages/core`: 162 tests / 20 files. Both packages: **193 tests**.

## 28. Stage 5 — Test & environment analysis (2026-08-16)

The last unbuilt deterministic stage. ARCHITECTURE.md §2's original spec
bundles four things into stage 5, all feeding one file
(`implementation/environment.md`) — reserved in `PKR_SPEC.md` §1's
directory vocabulary since early in the project, never populated until
now.

### What ships

- **New node type `environment-setup`** (`types.ts`, prefix `TECH` — same
  family as the other `implementation/`-layer types), wired into
  `render.ts`'s type→file mapping and `naturalKey.ts`'s
  `NATURAL_KEY_TYPES` so `pkr update`/`pkr diff` treat it like every other
  deterministic fact.
- **`extract/environment.ts`** (new file, mirroring one-file-per-stage —
  `inventory.ts`=1, `dependencies.ts`=2, `interfaces.ts`=3, `structure.ts`=4):
  - *Test file inventory*: a count from stage 1's classification, capped
    evidence (first 5 paths) — no test file content read here or anywhere
    in this module.
  - *Referenced environment variable names, never values* (`PKR_SPEC.md`
    §10): `process.env.NAME` / `process.env['NAME']` in source (a property
    *read* — the value never appears in source text, nothing to
    over-capture even in principle), plus `.env.example`/`.env.sample`/
    `.env.template`-named files specifically. A real `.env`/`.env.local`/
    `.env.production` is never opened, full stop — a deliberate second
    layer of defense on top of the value-discarding regex, not redundant
    with it (see Testing below for why that distinction turned out to
    matter in practice).
  - *CI/deployment config presence*: GitHub Actions, GitLab CI, CircleCI,
    Jenkins, Docker, Docker Compose — which platform is configured, not its
    contents.
- **Test *runner* identification deliberately not duplicated**: Jest/
  Vitest/etc. was already a `tech-choice` node via stage 2's
  `KNOWN_FRAMEWORKS` lookup, which gained `mocha`/`ava`/`tap`/`jasmine`/
  `cypress` the same day as a small, free complement.
- **`schema_version` stays `"0.1"`**, a deliberate decision not an
  oversight: `Manifest`'s `schema_version` is a hard `z.literal("0.1")`
  equality check, not a semver range. `PKR_SPEC.md` §0's own stated policy
  ("additive changes bump the minor version") would suggest `"0.2"` here,
  but bumping the literal would reject every already-exported PKR the
  moment `loadManifest`/`loadPkr` tries to parse it — every command except
  `pkr export` itself. Caught before making the change, not after; noted
  here and in the module doc as a real, tracked inconsistency between
  policy and practice rather than silently deviating from the stated rule.
- Wired into `pkr export` (`pipeline.ts`) and `pkr update`
  (`update/index.ts`) the same way every other stage-2/3/4 extractor is.

### Verified live against a real fixture, not just tests

A repo with `process.env.DATABASE_URL`/`PORT` in source, a `.env.example`
declaring `DATABASE_URL`/`API_KEY`, a **real** `.env` with an actual
secret-shaped value, a GitHub Actions workflow, and a `Dockerfile`: `pkr
export` correctly produced 4 nodes (test inventory, 3 merged env-var names,
GitHub Actions, Docker) in `implementation/environment.md` — and a `grep`
across the entire written `.projectknowledge/` output for the real `.env`'s
literal secret value came back clean.

### Testing

14 unit tests, `extract/environment.test.ts` (new). Worth calling out
specifically: the first version of the "never touches a real `.env`" test
asserted that a secret *value* never leaks — and that test **passed even
with the filename guard deliberately broken** (the regex only ever
captures the key before `=`, so the value-discarding property held
regardless of which files got scanned; the guard and the value-discard are
two independent protections, and the test was only exercising one of
them). Rewritten to assert that a variable name existing *only* in a real
`.env` never appears anywhere in the output at all — that version
correctly failed once the guard was disabled, with the failure output
showing the leaked node created from `.env`'s content in full, and passed
once restored. A useful reminder mid-session: a revert-and-check is only as
strong as what the assertion actually pins down, not just whether *some*
assertion in the vicinity happens to fail.

`packages/core`: 176 tests / 22 files. Both packages: **207 tests**.

## 29. `architecture/overview.md` narrative synthesis (2026-08-16)

The last stage-6 gap named throughout this document ("no matching node
type yet"). Unlike every other synthesized type, a narrative architecture
overview is inherently one holistic thing per project, not an atomic fact
— genuinely different in kind, not just another category to add to a list.

### What ships

- **New node type `architecture-overview`** (`types.ts`, prefix `ARCH` —
  same family as `component`/`boundary`/`deployment-unit`), added to
  `synthesize.ts`'s `SYNTHESIZABLE_TYPES` and wired into `render.ts` →
  `architecture/overview.md`, reserved in `PKR_SPEC.md` §1's directory
  vocabulary since early in the project and empty until now.
- **Prompt change** (`SYSTEM_PROMPT`, `synthesize.ts`): describes the type
  explicitly as "NOT another atomic fact like the types above," instructs
  the model to propose it only when it has cross-cutting signal (not just
  one file), and caps it at one per response — rules 4/5/6 each got a
  one-line addendum (domain tag convention, the cap, and that a revision
  should typically `supersedes` the previous one) rather than a separate
  rules section, keeping the existing seven-type instruction shape intact.
- **Independent code-level enforcement**, not just the prompt instruction:
  a second (or later) `architecture-overview` candidate in one response is
  routed to `skipped` with a specific reason, the same distrust-the-model
  posture already applied to evidence paths and `supersedes` IDs in this
  same function — a prompt instruction is a request, not a guarantee.
- Otherwise goes through the exact same pipeline as every other inferred
  type: evidence verification, weak-grounding tiering, `supersedes`
  reconciliation (§19) all apply unchanged — no special-casing needed
  beyond the one cap.

### Verified live with a real API call

Built a small but structurally real fixture (Express app: `app.js` mounting
`/auth` and `/points` routers, a `pointsService.js` with a deliberately
planted, non-obvious design decision — FIFO batch consumption on
redemption — and a Mongoose model) and ran real `pkr export` against it.
Result: exactly one `architecture-overview` node, confidence honestly at
0.5, evidence citing the four files that actually mattered
(`app.js`/`pointsService.js`/`PointsBatch.js`/`README.md`), and the
narrative itself correctly named FIFO batch consumption as "the core
architectural decision" — the model picked up the planted design
rationale, not just surface structure. Only one candidate was proposed in
the first place (the prompt instruction alone was sufficient here), so this
run validates the prompt; the code-level cap is validated separately via
the regression test below, deliberately, since a single real call proving
the happy path says nothing about what happens when a model doesn't
comply.

### Testing

4 unit tests (`synthesize.test.ts`) — accepts a single evidence-grounded
node normally; a REGRESSION test forcing two candidates through a fake LLM
response, confirming only the first is kept and the second lands in
`skipped` with the specific "only one... kept per synthesis run" reason
(verified by hand: removing the enforcement code turns exactly that one
test red, nothing else); the same evidence-verification path rejects an
architecture-overview claiming an unshown path exactly like it would for
any other type. 1 render-level test (`render.test.ts`) confirming the type
lands in `architecture/overview.md`.

`packages/core`: 180 tests / 22 files. Both packages: **211 tests**.

## 30. M8 — full-cycle real-world validation of the combined §24-29 surface (2026-08-16)

Every feature added this session (Knowledge Versioning, `pkr diff`,
`pkr compare`, `pkr confirm`/`pkr edit`, event detection, stage 5,
architecture-overview) had been validated individually. None had been run
together, end-to-end, against a real, large, unfamiliar, unscripted repo —
exactly the condition that found a real bug in every prior round of this
kind of testing (§16 M3, §20 M6, §21 M7). Chose
`thisisdkyadav/hostel-management-system-backend` (2 stars, not a fork, 568
commits, vetted via the GitHub API before cloning — same discipline as
M6/M7): a genuinely large modular-monolith Express/Mongoose backend (533
source files), unrelated in domain and structure to every fixture used
earlier this session.

**Full sequence run, two real API calls:** `pkr export --llm` at an early
commit (655 nodes, 13 inferred, 38s) → `pkr confirm` one node → `pkr edit`
another (deliberately diverging its content from ground truth, to set up a
real protection test) → checked out 32 real changed files forward →
`pkr update` (deterministic-only, correctly produced `+9 ~115 -1
1 conflict`) → checked out another 18 real changed files forward →
`pkr update --llm` (10 new inferred nodes, 27s, real business-rule
detail — e.g. "Guest occupancy computed temporally, never from
Room.occupancy") → `pkr log` (5 real chained versions, correct
human/extractor authorship) → `pkr diff v0.1 v0.5` (correct aggregate:
`+22 ~145 -2, 2 conflicts, 2 confirmed`) → `pkr reconstruct` (677 nodes,
no crash) → `pkr compare` against itself, both without and with
`--run-build` (547/547 endpoints, 78/78 tables, and a real `npm run test`
placeholder script — `exit 1` — correctly executed and reported as a real
failure with real captured output).

**One thing that looked like a bug and wasn't** — investigated properly
before concluding either way, not assumed: `pkr update` flagged the
earlier-edited node as `! "DELETE /" is confirmed but extraction now
disagrees`, on a file that hadn't even changed between commits. Traced it
by hand: re-running `analyzeApiEndpoints` directly against the current
checkout reproduced byte-identical title/content/evidence to what fresh
extraction would naturally give — the mismatch was entirely because the
earlier `pkr edit` step had deliberately set this node's content to
"Human-reviewed and corrected note for this fact.", diverging it from
ground truth on purpose as part of this same test. The conflict was
correct, not a bug — confirmed-node protection working exactly as
specified (PKR_SPEC.md §4.2) against a real, human-diverged fact at real
scale, persisting across two further update runs until a human resolves
it, exactly as designed. Recorded here because concluding "not a bug"
without tracing it first would have been exactly the kind of unverified
claim this project's own discipline exists to avoid.

**Zero new bugs found this round** — a genuinely clean result, not
"nothing happened": no crashes at 677 nodes / 547 endpoints, zero secret
leakage from a real 66-variable `.env` surface, correct absence of
event/CI/test nodes where the repo genuinely had none of those things
(not false negatives — independently verified each absence against the
real repo, same as the M6/M7 discipline), and `pkr compare`'s
`--run-build` path correctly executing and reporting a real failing
script it had never seen before. Read as evidence the individually-shipped
§24-29 features compose correctly under real conditions, not as proof
nothing is left to find — the session's own pattern (§21's own text) is
that composition bugs specifically tend to hide until features are run
together, so this is one clean data point, not a closed question.

## 31. Deliberate hard security + performance review (2026-08-16)

Requested explicitly, not tied to a specific bug report — an adversarial
read of the newest code (§24-30) plus real, empirical stress tests, not
just theorizing. Found and fixed three real issues, two of them
security-critical; verified several other suspected weak points and found
them sound.

### Found and fixed: `.knowledge/nodes.jsonl` never redacted (severity: high)

`PKR_SPEC.md` §10 states the rule plainly: "the exporter must never write a
literal secret value into any generated file." The secret write-gate
(`secrets.ts`) had only ever been wired into `render.ts` — the Markdown
output — never into `FileNodeStore.save()`, which writes the *internal*
store, itself a generated file inside `.projectknowledge/`. Confirmed with
a real AWS-shaped key, not hypothesized: `pkr edit --content` (the one code
path this session added that puts genuinely arbitrary human-typed text
into a node with no prior extraction/synthesis step in front of it) wrote
the raw secret to `nodes.jsonl` in plaintext while the rendered `.md`
correctly showed `[REDACTED:...]` — the two representations of the same
fact silently disagreed on the one guarantee that's supposed to hold
everywhere. Fixed in `FileNodeStore.save()`: redacts title/content on the
way to disk only (not the in-memory node, mirroring `render.ts`'s own
approach) — a single chokepoint covering every code path that calls
`store.save()` (export, update, confirm, edit), rather than remembering to
add it at each one individually. 1 regression test
(`fileNodeStore.test.ts`); verified by hand — reverting reproduces the
exact real AWS-key leak, fails only that test.

### Found and fixed: excerpt content sent to the LLM API was never redacted (severity: high — the more serious of the two)

A distinct, more serious version of the same gap: `buildExcerpts()`
(`synthesize.ts`) reads candidate files (README, entry points, the largest
source file, files a `pkr update` diff knows changed) and sends their raw
content directly to Anthropic's API as part of the stage-6 prompt — with
no redaction at all, ever, on any code path. Confirmed with a real,
adversarial reproduction: a fixture with an AWS-shaped key embedded in its
entry point, captured via a mock `LlmClient`, showed the literal key
present in the exact string that would be sent as the API request body.
This is data leaving the machine to a third party, not just an
at-rest-on-disk concern — the more severe of this review's two findings.
Root cause: the secret write-gate was designed around "content written to
`.projectknowledge/`" and a prompt sent to an LLM is a genuinely different
kind of destination the original design never had in view. Fixed at the
single point every excerpt's content passes through regardless of which
selection rule picked it (`buildExcerpts()`'s final assembly loop) —
`redactSecrets()` applied before the content is added to the returned
excerpt list. New `excerptRedactions` count threaded through
`SynthesisResult` → `SynthesisReport`/`LlmUpdateReport` → CLI output for
both `pkr export` and `pkr update --llm`, mirroring the existing
`totalRedactions` pattern for render-time redactions (kept as a *separate*
count — conflating "redacted before being sent to Anthropic" with
"redacted before being written to your local files" would blur an
important distinction). 2 regression tests (`synthesize.test.ts`);
verified by hand — reverting reproduces the exact real leak from the
adversarial reproduction above.

### Found and fixed: O(n²) node matching in `pkr update` (severity: real but lower — scale-dependent, not exploitable)

`mergeDeterministicNodes` (`update/mergeNodes.ts`) matched each freshly
re-extracted candidate against the existing node set via
`oldNodes.find(...)` — a linear scan repeated for every candidate, O(n×m)
overall. Measured, not assumed: a standalone 10,000-node benchmark showed
10x the nodes costing ~70x the time, not 10x. At the scale this session's
own real-repo validation ran (§30, 547 endpoints), the cost was
sub-millisecond and invisible; the growth curve is the actual problem for
a project that scales further. Fixed by indexing existing nodes into a
`Map<naturalKey, node>` once per type (O(n)) instead of scanning per
candidate — first-match-wins per key, exactly preserving `.find()`'s old
behavior on `store.listNodes()`'s ID-sorted output. Same benchmark
post-fix: 10,000 nodes in ~60ms (was ~483ms), and the 8x-node-count
scaling test added as a permanent regression is now linear (2,000→16,000
nodes: ~8x time, not ~34x). 1 performance regression test
(`mergeNodes.test.ts`) asserting the *shape* of the scaling (large ≤
small×20+200ms) rather than an absolute bound, sized by hand against the
actual pre/post-fix measurements so it discriminates reliably without
being flaky on a slower CI machine; verified by hand — reverting the fix
reproduces a real ~2000ms failure against a ~1145ms budget.

### Checked, no issue found

- **ReDoS**: every new regex added this session (event detection, env-var
  scanning, CI-marker detection) either has no nested/ambiguous quantifiers
  (simple anchored patterns) or reuses the established
  `(?:\\.|(?!\1).)*` "quoted-string content" shape already used throughout
  `interfaces.ts` since early in the project — the two alternatives can
  never match the same input at the same position, which is what actually
  prevents catastrophic backtracking, not just "looks similar to a safe
  one." `readSafe()`'s existing 512KB file-size cap (`interfaces.ts`,
  `environment.ts`) also bounds worst-case input size regardless.
- **`pkr compare --run-build`'s subprocess execution**: re-verified rather
  than re-trusted the earlier build-time reasoning. `npm run <script>` is
  always one of exactly two literal strings ("build"/"test"), never
  assembled from repo content; `cwd` is a resolved path, never
  shell-interpreted; `timeout: 120_000` bounds a hung process.
- **`versions.ts` scaling**: `listVersions()`/`commitVersion()` read every
  version file on every call — O(n) per call, O(n²) cumulative over a
  project's lifetime. Measured at a real (large) scale: 500 existing
  version files, next `commitVersion()` call at 12.9ms, `listVersions()` at
  13.3ms. A project would need roughly 1,000+ `pkr update` calls in its
  entire history before this became tens of seconds of *cumulative*
  overhead spread across that whole history — never a single
  user-noticeable slow operation the way the `mergeNodes` finding was.
  Left as-is; fixing it would mean a persisted running counter (like
  `IdAllocator`'s `counters.json`), real added complexity for a cost this
  session's own real-repo validation (§30) never came close to triggering.

### Testing

4 new regression tests total across the three fixes (1 in
`fileNodeStore.test.ts`, 2 in `synthesize.test.ts`, 1 performance test in
`mergeNodes.test.ts`), every one verified by hand via revert-and-check
against the actual real-world reproduction that found it, not a
synthetic case invented after the fact. `packages/core`: 184 tests / 22
files. Both packages: **215 tests**.

## 32. Packaging readiness and first publish — single-package bundle, license, identity (2026-08-17)

User-driven, in an explicit order: license → identity → packaging check →
npm instructions. Started as readiness-only prep (the user had no npm
account at the start of this section) and ended with a real publish once
the account existed — see "Published for real," below.

**License**: root `LICENSE` is the Elastic License 2.0 (`Elastic-2.0` SPDX
id in all three `package.json`s) — free use/modify/redistribute, the one
restriction being offering the software to third parties as a hosted/
managed service, chosen specifically to protect a possible future hosted
`klerk` offering (§7's already-planned, still-unbuilt M6+) from being
undercut by someone else's hosted fork. Category precedent: Sentry,
CockroachDB.

**Identity**: `author: "stratoske"` (pseudonym, by explicit choice — not a
real name) and `repository`/`homepage`/`bugs` on all three `package.json`s,
pointing at a **new dedicated public repo**,
`github.com/stratoske-corne/klerk-pkr` (the original repo, same account,
stays private under its original name and is kept as a second git remote,
`private`, purely as a backup — `origin` now tracks the new public repo).

**The two-npm-package problem and its fix**: `packages/cli` (`@klerk/cli`)
depended on `packages/core` (`@klerk/core`) as a literal-version npm
dependency — fine inside the monorepo (npm workspaces symlink it), but
published as-is it would require `@klerk/core` to *also* be published to
npm separately, under a real scope, before the user has chosen one.
Fixed by renaming the publishable package from `@klerk/cli` to the
unscoped **`klerk`** (verified available on the registry earlier this
session) and adding an esbuild bundle step (`npm run bundle`, wired as a
`prepack` script so it always runs before `npm pack`/`npm publish`) that
inlines all of `@klerk/core`'s compiled output directly into one file,
`dist/index.cjs` — `@klerk/core` becomes a **build-time-only
devDependency**, never a published runtime dependency. `packages/core`'s
own `package.json` gained `"private": true` as a second line of defense
against ever publishing it directly.

Two real bugs, both found only because the check was a real `npm pack` +
fresh, isolated `npm install -g` (a brand-new temp prefix, run from
*outside* the monorepo, on a brand-new fixture repo — never trusting the
in-monorepo `node bin/pkr.js` run, which kept working throughout via
workspace-hoisted `node_modules` and would have hidden both of these):

1. **ESM bundle output couldn't run at all** — `esbuild --format=esm`
   choked on `commander`'s internal `require("node:events")` with "Dynamic
   require ... is not supported," a known esbuild limitation when bundling
   a CJS dependency into an ESM target. Fixed by bundling to CJS instead
   (`dist/index.cjs`, package `"type"` stays `"module"` — Node's ESM
   loader can `import` a `.cjs` file directly for its side effects, which
   is all `bin/pkr.js`-equivalent loading needs). This in turn broke
   `@klerk/core`'s `createRequire(import.meta.url)` `ignore`-package
   loader (`import.meta` is empty under esbuild's `cjs` format) — fixed
   with esbuild's own documented workaround, an injected shim
   (`scripts/import-meta-url-shim.js`) substituting a real `file://` URL
   built from CJS's ambient `__filename` via `--define`/`--inject`.
2. **`npm install -g` of the packed tarball crashed with `Cannot find
   module 'ignore'`** — `createRequire(...)("ignore")` is a genuine
   runtime `require()` call as far as esbuild's bundler is concerned (that
   *is* the point of the `createRequire` pattern — it deliberately opts
   out of static bundling), so `ignore` was never inlined into
   `dist/index.cjs`, only referenced. It happened to resolve fine inside
   the monorepo (hoisted to the repo root's `node_modules`) but not in a
   real standalone install. Fixed by declaring `"ignore"` as an explicit
   runtime `dependencies` entry of the published `klerk` package — the
   one intentional external dependency of an otherwise fully
   self-contained bundle. Confirmed by grepping the actual bundle output
   for every remaining bare (non-`node:`) `require(...)` call after the
   fix — `ignore` was the only one; nothing else was silently left
   unbundled.

Also caught by the same real-pack check, before either bug: `"files":
["dist"]` would have shipped stale `tsc` build leftovers sitting in the
same directory — `dist/index.test.js`, source maps, `.d.ts` files —
tightened to the exact single artifact, `"files": ["dist/index.cjs",
"LICENSE", "README.md"]`. `packages/cli/README.md` (new) is the npm-facing
package page content — install/quick-start/license summary — separate
from `ARCHITECTURE.md`/`PRODUCT_SPEC.md`'s audience. The root `LICENSE` is
copied into `packages/cli/` by the `prepack` script (single source of
truth, gitignored copy) since npm only auto-includes a `LICENSE` that
lives inside the package directory being published, not one sitting at
the monorepo root.

**Verified for real, end to end**: `npm run build` (the unchanged, tsc-based
dev path) and the full test suite (**215 tests**, unchanged) both still
pass after every change above — the bundle/publish pipeline is additive,
not a replacement for local dev/test. Then, separately: `npm pack` inside
`packages/cli` → `npm install -g --prefix <fresh temp dir>` from the
resulting `.tgz` (not from the workspace) → `pkr export` against a brand
new fixture repo created outside the monorepo entirely, from a shell
whose `PATH` only has the fresh install's `bin/` on it. Real extraction
output (4 nodes, 8 files written), then a second real `pkr update` run
confirming incremental re-sync also works from the standalone install.
`npm install -g` added exactly 2 packages (`klerk` + `ignore`) — nothing
else, confirming the bundle really is self-contained.

**Publish attempt #1 — a third real bug, found only by npm's own server,
not by anything client-side**: the first `npm publish` (unscoped `klerk`)
was rejected with `403 Package name too similar to existing package
kleur` — npm's anti-typosquatting check, comparing against the popular
`kleur` terminal-color library. No local check (registry existence check,
`npm pack --dry-run`) could have caught this — it's a server-side policy
decision, only surfaced by actually attempting the real publish. Fixed
per npm's own suggested remedy: renamed the package to the scoped
**`@stratoske/klerk`** (scopes are namespaced per npm username, so this
name is unconditionally available — no separate reservation needed) and
added `"publishConfig": { "access": "public" }` (scoped packages default
to *private*, which requires a paid plan, unless access is explicitly
declared public). The `pkr` command name is unaffected — package name and
bin name are independent fields.

**Published for real**: `npm publish` succeeded —
[`@stratoske/klerk@0.1.0`](https://www.npmjs.com/package/@stratoske/klerk)
is live on the public registry. Verified three ways, each a real network
call rather than a local assumption: (1) `GET
registry.npmjs.org/@stratoske/klerk` — the registry's own copy of the
manifest, `fileCount: 4`, matching the local `npm pack --dry-run` exactly;
(2) `npm install -g @stratoske/klerk` from the *actual* registry (not a
local tarball) into a fresh temp prefix; (3) a real `pkr export` run
against a brand-new fixture repo through that install — 4 nodes, 8 files
written, exit code 0. This is the first artifact in the project's history
that a stranger, anywhere, can install with one command
(`npm install -g @stratoske/klerk`) and get a working `pkr`.
files. Both packages: **215 tests**.
