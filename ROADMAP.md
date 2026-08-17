# Klerk — Roadmap

A one-page pointer to what's done and what's next. For the full technical
history (every decision, bug found, and how it was verified), see
[`ARCHITECTURE.md`](./ARCHITECTURE.md) — this file is deliberately short.

## Done

- **M1 — CLI export loop.** `pkr export` → `.projectknowledge/`, deterministic
  extraction (stages 1–5) plus optional LLM synthesis (stage 6).
- **M2 — Reconstruction package.** `pkr reconstruct` turns a PKR into a
  build spec for a fresh AI agent.
- **M3 — Real-repo validation.** Full export → reconstruct → blind-agent-rebuild
  loop run against real external repositories.
- **M4 — Gap analysis.** Real gaps found during M3 fed back into fixes.
- **M5 — Schema revision.** Fixes re-validated against a second real repo.
- **Knowledge Versioning, `pkr diff`, `pkr compare`, `pkr confirm`/`pkr edit`.**
  The human-correction and change-tracking surface — see `ARCHITECTURE.md`
  §24–26.
- **Event detection, environment/test analysis, architecture-overview
  synthesis.** Closed the remaining extraction gaps — §27–29.
- **M8 — Combined full-cycle validation.** Every feature above exercised
  together against one real, large, unfamiliar repo — §30.
- **Security + performance hardening.** A deliberate adversarial review;
  three real issues found and fixed — §31.
- **Packaging and first publish.** [`@stratoske/klerk`](https://www.npmjs.com/package/@stratoske/klerk)
  is live on npm — §32.

## Where things stand today

- **Install**: `npm install -g @stratoske/klerk` — gives you the `pkr` command
- **License**: [Elastic License 2.0](./LICENSE) — free to use/modify, the one
  restriction is offering it as your own hosted service
- **Tests**: 215 passing (184 core, 31 CLI)
- **Commands**: `export`/`init`, `update`, `reconstruct`, `context`, `log`,
  `diff`, `compare`, `confirm`, `edit`

## Not yet built

- **M6+ — Hosted platform.** Postgres/Prisma storage, auth, a Next.js web
  app (dashboard/explorer/graph/versions/diff), `pkr update` exposed via
  API, a UI for human correction instead of only CLI. Deliberately
  deferred until the CLI-only loop above was proven for real — see
  `ARCHITECTURE.md` §7 and §9.
- **Full draft/commit review workflow.** `PKR_SPEC.md` §7 describes a
  richer draft → review → commit cycle; today `pkr export`/`pkr update`
  auto-commit a Knowledge Version on every real change (§24's MVP scope).
- **Deeper `pkr compare`.** Currently: name-set diffs for API/schema,
  Jaccard similarity for architecture, real build/test execution
  (opt-in). Not yet built: shape/column-level schema diff, running the
  original's own test suite against a reconstruction as a black-box
  contract test.

## Links

- [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) — what Klerk is and why
- [`PKR_SPEC.md`](./PKR_SPEC.md) — the `.projectknowledge/` format itself
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how it's built, every decision
  and fix, in order
