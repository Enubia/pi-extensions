# lsp

Language-server intelligence for pi: diagnostics, hover, definition, references, symbols, and automatic type-error feedback after `write`/`edit`.

Zero npm dependencies — JSON-RPC framing is implemented in `protocol.ts`, `typebox` comes from the pi host.

## Tools

| Tool | Input | Output |
| --- | --- | --- |
| `lsp_diagnostics` | `path` | `path:line:col severity: message (code) [source]`, errors first |
| `lsp_hover` | `path`, `line`, `column` (1-based) | type signature / docs |
| `lsp_definition` | `path`, `line`, `column` | locations |
| `lsp_references` | `path`, `line`, `column`, `includeDeclaration?` | locations, capped at 60 |
| `lsp_document_symbols` | `path` | indented outline with line numbers |
| `lsp_workspace_symbols` | `query`, `anchorPath?` | symbols across running servers |

After a successful `write`/`edit` on a file whose server is already running, errors (max 10 lines) are appended to the tool result. `read` keeps the server's document view in sync. Servers start lazily on first `lsp_*` call and are one process per `(server id, project root)`.

## Command

`/lsp` — status of running servers (state, pid, pull/push diagnostics, root, command)
`/lsp restart [id]` — stop servers; they restart on next use
`/lsp servers` — configured servers and their extensions

## Built-in servers

| id | extensions | binary resolution |
| --- | --- | --- |
| `typescript` | `.ts .tsx .js .jsx .mts .cts .mjs .cjs` | Ancestor-resolved workspace TypeScript: native `tsc --lsp --stdio` for 7+, pinned `typescript-language-server --stdio` for legacy versions. Without workspace TypeScript: local native preview, then bridge, then PATH `tsgo --lsp --stdio`. |
| `go` | `.go` | `gopls` on PATH |
| `rust` | `.rs` | `rust-analyzer` on PATH |
| `python` | `.py .pyi` | `pyright-langserver --stdio` (local, then PATH) |

Only `typescript` has been verified end-to-end: TS 5.9.3 and 6.0.3 with `typescript-language-server` 6.0.0, TS 7.0.2, and native preview 7.0.0-dev.20260707.2. The other languages are declarative and untested.

### TypeScript selection

The nearest tsconfig/jsconfig/package directory remains the LSP project root. Compiler discovery searches its `node_modules` and ancestors, including hoisted monorepo and worktree dependencies. The nearest `typescript` package wins; a preview never replaces an installed workspace compiler automatically.

Native launchers come from the selected package's `bin` metadata and run via the current Node executable, avoiding unrelated `.bin/tsc` shims. `typescript@7+` uses `tsc`; `@typescript/native-preview` uses `tsgo`. Both receive `--lsp --stdio`. For legacy TypeScript, the bridge is searched locally and through ancestors before PATH, and receives the selected `lib/tsserver.js` through `initializationOptions.tsserver.path`.

Broken workspace packages fail rather than falling back to another compiler. Missing native platform dependencies are reported with startup stderr; reinstall with optional dependencies enabled. A legacy compiler without a bridge reports that `typescript-language-server` must be installed. A bare `tsc` on PATH is never assumed to support LSP. Explicit server configuration still overrides this selection.

`/lsp` shows the selected command; `/lsp restart typescript` clears cached startup failures after repairs.

## Adding a language

Two options.

**Config (no code):** `~/.pi/agent/lsp.json` (global) or `<project>/.pi/lsp.json` (project). Entries with an existing `id` replace the built-in; `enabled: false` or `disabled: [...]` removes one.

```json
{
  "servers": [
    {
      "id": "vue",
      "extensions": { ".vue": "vue" },
      "rootMarkers": ["package.json"],
      "bin": "{root}/node_modules/.bin/vue-language-server",
      "args": ["--stdio"],
      "initializationOptions": { "typescript": { "tsdk": "{root}/node_modules/typescript/lib" } },
      "diagnosticsSettleMs": 500,
      "diagnosticsMaxWaitMs": 8000
    }
  ],
  "disabled": ["python"]
}
```

`bin` containing `/` is used as-is (after `{root}` substitution), otherwise looked up on PATH.

**Code:** add a `ServerSpec` to `registry.ts` and push it into `builtinSpecs`. `resolve` decides the binary per project root and gets a `which` helper; use `initializationOptions`/`settings` for server-specific setup.

## Diagnostics model

- Servers advertising `diagnosticProvider` are queried with `textDocument/diagnostic` (pull). Required for TypeScript 7 source-file diagnostics; TS7 can separately push project/config diagnostics to tsconfig URIs. Pushes for unopened documents are not retained.
- Otherwise the client waits for the first `publishDiagnostics` for the file, then until `diagnosticsSettleMs` of quiet, capped at `diagnosticsMaxWaitMs`.

## Layout

```
protocol.ts   Content-Length framing, message type guards      (pure, tested)
transport.ts  spawn + JSON-RPC request/notify/server-requests
types.ts      minimal LSP wire types used here
registry.ts   ServerSpec catalog, backend selection, user-config merge, root finding
typescript.ts ancestor package discovery and native launcher validation
client.ts     one server process: initialize, doc sync, LSP requests
manager.ts    (spec, root) → client lifecycle, trust gate, config loading
format.ts     LSP results → compact text for the model          (pure, tested)
tools.ts      pi tool registrations
index.ts      extension entry: hooks, /lsp command
```

Tests from the package root: `node test/support/run-tests.mjs test/lsp/*.test.ts`

Real-server tests are opt-in and never install dependencies automatically. Set any of these to an installed **package directory**, not its executable: `PI_LSP_TEST_TS7_PACKAGE`, `PI_LSP_TEST_PREVIEW_PACKAGE`, `PI_LSP_TEST_LEGACY_PACKAGE`. Legacy checks also require `typescript-language-server` on PATH. Run the test runner directly; `npm test` uses an isolated environment without these variables.

```bash
PI_LSP_TEST_TS7_PACKAGE=/path/to/node_modules/typescript \
  node test/support/run-tests.mjs test/lsp/typescript.integration.test.ts
```

These tests exercise ancestor discovery, all six tools, diagnostics after edits, and restart/cleanup. Pin the installed versions for reproducible results.

## Known gaps (from review, deferred)

- `workspace/configuration` returns the same `settings` object for every requested section; gopls/rust-analyzer ask per section — make `settings` section-keyed before verifying them.
- No `workspace/didChangeWatchedFiles`, no `$/progress` handling — Go/Rust may answer mid-index or see stale files. TS7 may also miss changes to unopened dependencies/configs on platforms without its native watcher fallback (notably Linux).
- One extension maps to exactly one spec; a Vue setup needing both `vue-language-server` and tsserver on `.vue` is not expressible yet.
- Only `write`/`edit` trigger auto-diagnostics; other editing tools are ignored.
