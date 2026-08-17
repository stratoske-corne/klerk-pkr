// esbuild-documented workaround for bundling `import.meta.url` into the CJS
// output format (esbuild leaves `import.meta` empty for "cjs" targets — see
// the "import.meta is not available with the cjs output format" warning).
// `@klerk/core`'s inventory.ts uses `createRequire(import.meta.url)` to load
// the CJS-only `ignore` package under NodeNext; this shim gives the bundled
// CLI a real `file://` URL to substitute in its place via
// `--define:import.meta.url=importMetaUrl --inject:<this file>`.
export const importMetaUrl = require("url").pathToFileURL(__filename).href;
