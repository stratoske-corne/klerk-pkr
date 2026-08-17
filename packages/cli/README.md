# klerk

`pkr` — generate and maintain a **Project Knowledge Repository**
(`.projectknowledge/`) for any software repository: version-controlled,
evidence-grounded documentation that both humans and AI coding agents can
read, separate from the code itself.

## Install

```bash
npm install -g klerk
```

This installs the `pkr` command globally.

## Quick start

```bash
pkr export ./my-repo          # analyze a repo, write .projectknowledge/
pkr context ./my-repo/.projectknowledge   # hand it to an AI agent as continuation context
pkr update ./my-repo          # re-sync after the code has changed
```

Run `pkr --help` for the full command list (`export`/`init`, `update`,
`reconstruct`, `context`, `log`, `diff`, `compare`, `confirm`, `edit`).

### Optional: semantic synthesis

Set `ANTHROPIC_API_KEY` in your environment before running `pkr export` /
`pkr update` to also generate the product/behavior sections (an LLM call).
Without it, `pkr` still runs — it produces deterministic, evidence-only
extraction (architecture/interfaces/implementation), just without the
synthesized narrative sections.

## What gets written

`pkr export` writes a `.projectknowledge/` directory next to your code:
Markdown files meant to be read (and committed to git) plus a
`.knowledge/` subfolder holding the underlying structured data
(nodes/edges/versions). Nothing here talks back to any server — it's all
local files.

## License

[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license) —
free to use, modify, and redistribute; the one restriction is offering
this software to third parties as your own hosted/managed service. See
`LICENSE`.

## Links

- Repository: https://github.com/stratoske-corne/klerk-pkr
- Issues: https://github.com/stratoske-corne/klerk-pkr/issues
