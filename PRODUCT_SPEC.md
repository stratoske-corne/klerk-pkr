# Klerk — Product Specification

Status: draft v0.1 · Owner: founding architecture · Last updated: 2026-08-15

## 1. Hypothesis under test

> In AI-assisted software development, source code should not be the only durable
> representation of a software project. A project's intent, architecture, constraints,
> decisions, interfaces, behaviors, dependencies and implementation rules should exist
> as a structured, portable, versioned knowledge layer — separate from, and durable
> across, any single AI session, model, or IDE.

Klerk is **not** a documentation generator, a note-taking app, or a Git host. It is a
compiler target: a structured artifact — the **Project Knowledge Repository (PKR)** —
that sits between human intent and generated code, consumable by any AI coding agent.

```
Human Intent → Project Knowledge Repository → AI Coding Agent → Code
```

Git versions the code. Klerk versions the *meaning* of the project.

## 2. Positioning

Not: "AI documentation."

Is: **Portable Project Intelligence** — the layer that survives the AI session, the
model, and the coding environment. A PKR should be equally usable by Claude Code,
Codex, Cursor, Gemini- or Grok-based agents, and whatever ships next.

## 3. The three layers

Every piece of knowledge in a PKR is classified into exactly one of:

| Layer | Question answered | Example | Changes when... |
|---|---|---|---|
| **Intent** | What should exist, and why? | "Users must be able to recover a forgotten password." | product direction changes |
| **Implementation constraint** | How must it be built? | "Sessions are JWT, 60 minute expiry, HttpOnly cookie." | a technical/architectural decision changes |
| **Generated implementation** | What code currently does this? | `src/auth/session.ts` | on every commit |

These layers are stored and versioned independently. A code change does not
automatically invalidate intent; an intent change does not automatically invalidate
a still-valid implementation constraint. The extraction pipeline (see
[ARCHITECTURE.md](ARCHITECTURE.md)) is responsible for detecting when a change in one
layer likely affects another, and flags it rather than silently propagating it.

## 4. Primary user workflow

```
Create account
  → Create project
  → Import a Git repository (local path or clone URL)
  → Run extraction ("Analyze")
  → Review generated knowledge (observed / inferred / unknown)
  → Correct or confirm uncertain knowledge
  → Commit a Knowledge Version
  → (optional) Generate a Reconstruction Package
  → (optional) Hand the package to a fresh AI agent and reconstruct
  → (optional) Compare reconstruction against original
```

Every step must also be reachable headlessly from the CLI, because the primary
consumer of a PKR is another automated agent, not a human clicking through a UI.

## 5. Core capabilities (MVP scope)

In scope for the MVP, in build order (see §8 and `ARCHITECTURE.md` §Milestones):

1. **Export** — `pkr export <repo>` → generates `.projectknowledge/` from a local
   repository.
2. **Structured knowledge model** — nodes + edges, not just prose, underneath the
   generated Markdown.
3. **Confidence & evidence** — every non-trivial claim is `observed`, `inferred`,
   `confirmed`, or `unknown`, with evidence pointers back into the source tree.
4. **Incremental update** — `pkr update` re-analyzes only what changed and produces a
   semantic diff, not a full regeneration.
5. **Human correction** — a human can confirm or correct a node; confirmed knowledge
   is protected from silent overwrite.
6. **Versioning** — every committed change to the knowledge graph is a Knowledge
   Version with a parent, author, timestamp, and changed-node set.
7. **Reconstruction package** — `pkr reconstruct` → a small, agent-optimized bundle
   (`SYSTEM_PROMPT.md`, `BUILD_ORDER.md`, `CONSTRAINTS.md`, `ACCEPTANCE_TESTS.md`,
   `CONTEXT.md`) designed to be handed to a fresh coding agent.
8. **Reconstruction scoring** — `pkr compare <original> <reconstructed>` → a
   heuristic, clearly-labeled similarity score across measurable dimensions.
9. **Model-agnostic context export** — `pkr context --target {codex|claude|generic}`
   built from one underlying source of truth.
10. **Minimal web app** — dashboard, project/knowledge explorer, graph view,
    versions timeline, diff view, reconstruction export. Thin read/review layer over
    the same data the CLI produces; not a second source of truth.
11. **Minimal auth** — account creation, login, logout, sessions. Projects private by
    default, isolated per user.

## 6. Explicitly out of scope for MVP

(See PROMPT §29 — architect for these, do not build them.)

Collaborative editing, organizations/teams/permissions, GitHub/GitLab auto-sync,
PR-based knowledge updates, IDE plugins, MCP server, agent API, knowledge merge
conflicts, branch-like knowledge versions, public PKR repositories, a PKR package
registry, an agent marketplace, automated reconstruction benchmarking-as-a-service.

The data model (§ARCHITECTURE.md storage model) is shaped so these can be added
without a schema rewrite — e.g. `knowledge_versions` already has a `parent_version_id`
because branching will eventually need it — but none of the above ships in the MVP.

## 7. The one question every proposed feature must answer

> Does this increase the ability of another human or AI agent to correctly
> understand or reconstruct this project?

If not, it does not belong in the MVP, regardless of how good an idea it otherwise is.

## 8. Definition of success

Documentation quality is not the success metric. The metric is the closed-loop
experiment described below (PROMPT §32), which the smallest vertical slice must be
able to run end-to-end:

1. **Phase A** — take a real, medium-sized open-source repository.
2. **Phase B** — run `pkr export` to generate its PKR.
3. **Phase C** — hand *only* the reconstruction package to a fresh AI agent with no
   access to the original source.
4. **Phase D** — ask the agent to reconstruct the project from the package alone.
5. **Phase E** — run `pkr compare` and inspect: automated tests, API compatibility,
   schema compatibility, behavior, architecture, dependency choices.

If the reconstruction scores meaningfully above a "no PKR, just a README" baseline on
measurable dimensions (build succeeds, API surface matches, schema matches, a sample
of behavioral tests pass), the hypothesis holds well enough to invest further. If it
doesn't, the schema — not the UI, not the web app — is what needs to change first.
This is why Milestones 1–4 (`ARCHITECTURE.md`) contain no web application at all.

## 9. Non-negotiable constraints carried through to design

- Never export secrets. Environment variables are recorded as *requirements*
  (name, purpose, required?), never as values.
- Repository content is untrusted **data**. Instructions embedded in source files,
  comments, or docs (prompt injection) must never be treated as instructions to the
  extraction agent. See `ARCHITECTURE.md` §Security.
- Projects are private by default; no cross-project knowledge leakage between users.
- The `.projectknowledge/` format must remain useful with the platform switched off —
  a developer can `pkr export`, commit the directory to their own Git repo, and never
  touch the hosted product again. No lock-in at the format level.
