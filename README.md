# Klerk

Klerk builds a **Project Knowledge Repository** (`.projectknowledge/`) for
any software repository: a version-controlled, evidence-grounded layer of
documentation that lives *next to* the code, not inside a wiki or a chat
history — readable by humans and by AI coding agents alike.

```bash
npm install -g @stratoske/klerk
pkr export ./my-repo
```

That's it — `pkr` scans the repo and writes a `.projectknowledge/`
directory: architecture, interfaces, implementation notes, and (with an
API key) product/behavior narrative, each fact traceable back to the file
and line it came from.

## How it's different

- **Evidence-grounded, not guessed.** Every fact carries a status —
  `observed` (read directly from code), `inferred` (LLM-proposed, cited),
  `confirmed` (a human said so), or `unknown` — never presented as
  certain when it isn't.
- **Version-controlled like code.** Every real change commits an
  immutable Knowledge Version (`pkr log`, `pkr diff`) — you get a real
  history of what the project's documentation *believed* over time, not
  just what the code did.
- **Separate from the code, on purpose.** It's not comments, not a wiki
  someone forgets to update, not a chat log with an AI that vanishes at
  the end of the session. It's plain files, committed to your repo,
  meant to outlive any single AI session or model.
- **Corrections are protected.** Once a human confirms or edits a fact
  (`pkr confirm`/`pkr edit`), later re-extraction can't silently
  overwrite it — a real change instead produces a conflict for a human
  to resolve.

## Commands

| Command | What it does |
|---|---|
| `pkr export` (alias `init`) | Analyze a repo, generate `.projectknowledge/` from scratch |
| `pkr update` | Incrementally re-sync after the code has changed, preserving confirmed knowledge |
| `pkr context` | Render a single continuation-context file for an AI agent about to keep working on the project |
| `pkr reconstruct` | Turn a PKR into a build spec for a fresh AI agent to rebuild the project from |
| `pkr log` | Show the Knowledge Version history |
| `pkr diff <from> [to]` | Show what changed between two committed versions |
| `pkr compare <original> <reconstruction>` | Score how well a reconstruction matches the original |
| `pkr confirm` / `pkr edit` | Mark a fact as human-confirmed, correcting it first if needed |

Run `pkr --help` any time for the full reference.

### Optional: semantic synthesis

Set `ANTHROPIC_API_KEY` before running `pkr export`/`pkr update` to also
generate the product/behavior narrative sections (one LLM call). Without
it, `pkr` still runs — deterministic, evidence-only extraction, no
narrative sections.

## Learn more

- [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) — what Klerk is and why
- [`PKR_SPEC.md`](./PKR_SPEC.md) — the `.projectknowledge/` format itself
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how it's built, every decision in order
- [`ROADMAP.md`](./ROADMAP.md) — what's done, what's next

## License

[Elastic License 2.0](./LICENSE) — free to use, modify, and redistribute;
the one restriction is offering this software to third parties as your
own hosted/managed service.
