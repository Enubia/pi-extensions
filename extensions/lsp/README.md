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
| `typescript` | `.ts .tsx .js .jsx .mts .cts .mjs .cjs` | `node_modules/.bin/tsc --lsp` when `tsserver.js` is absent (TypeScript 7), else `typescript-language-server --stdio` (local, then PATH), then `tsc --lsp`, then `tsgo --lsp` |
| `go` | `.go` | `gopls` on PATH |
| `rust` | `.rs` | `rust-analyzer` on PATH |
| `python` | `.py .pyi` | `pyright-langserver --stdio` (local, then PATH) |

Only `typescript` (both TS 5 and TS 7) has been verified end-to-end; the others are declarative and untested.

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

- Servers advertising `diagnosticProvider` are queried with `textDocument/diagnostic` (pull). Required for TypeScript 7, which never pushes file diagnostics.
- Otherwise the client waits for the first `publishDiagnostics` for the file, then until `diagnosticsSettleMs` of quiet, capped at `diagnosticsMaxWaitMs`.

## Layout

```
protocol.ts   Content-Length framing, message type guards      (pure, tested)
transport.ts  spawn + JSON-RPC request/notify/server-requests
types.ts      minimal LSP wire types used here
registry.ts   ServerSpec catalog, user-config merge, root finding (pure, tested)
client.ts     one server process: initialize, doc sync, LSP requests
manager.ts    (spec, root) → client lifecycle, trust gate, config loading
format.ts     LSP results → compact text for the model          (pure, tested)
tools.ts      pi tool registrations
index.ts      extension entry: hooks, /lsp command
```

Tests from the package root: `node test/support/run-tests.mjs test/lsp/*.test.ts`

## Known gaps (from review, deferred)

- `workspace/configuration` returns the same `settings` object for every requested section; gopls/rust-analyzer ask per section — make `settings` section-keyed before verifying them.
- No `workspace/didChangeWatchedFiles`, no `$/progress` handling — Go/Rust may answer mid-index or see stale files.
- One extension maps to exactly one spec; a Vue setup needing both `vue-language-server` and tsserver on `.vue` is not expressible yet.
- Only `write`/`edit` trigger auto-diagnostics; other editing tools are ignored.
