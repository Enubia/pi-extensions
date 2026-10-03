# observational-memory (hybrid)

Session-ledger memory for pi with mid-run compaction. Seeded from elpapi42's
`pi-observational-memory` 3.1.3; compaction control and operability ported from
amosblomqvist's implementation. See `NOTICE`.

## What it does

- **Observer → reflector → dropper** workers distill raw conversation into observations
  (timestamped, id-addressed) and reflections, recorded as `om.*` entries in the session JSON.
  Memory records live in the session ledger; other existing outputs are described below.
- **Compaction fires on `turn_end`**, not after the run settles. Progress is provider-reported
  context growth since the last compaction (raw estimate as fallback). A compaction that lands
  mid-run resumes the agent automatically via a hidden message.
- **Cutoff snapping**: the verbatim tail starts at an observation-chunk boundary closest to
  `tailTokens`, so nothing is both summarised and kept, and nothing is dropped. Falls back to
  pi's proposal when no boundary qualifies.
- **Fold waits for workers**: `session_before_compact` awaits an in-flight consolidation and
  re-reads the branch so just-recorded observations land in the block.
- **`recall(<id>)`** tool recovers the raw source entries behind any observation/reflection id.
- **Cost tracking**: every worker run appends `om.cost`; the total sums all entries across all
  branches (never decreases under `/tree`).
- **Statusline seam**: `src/status/snapshot.ts` exports `memorySnapshot(ctx)` — the only module
  `../statusline.ts` imports lazily from the same package.

## Commands

| Command | Effect |
|---|---|
| `/om`, `/om on`, `/om off` | Per-session gate, persisted in the ledger (`om.enabled`); default on |
| `/om:status` | Memory, activity, worker cost, compaction settings, in-flight state, last errors |
| `/om:view [full]` | Display visible memory (default) or all recorded memory (`full`); automatically attempt to copy the displayed content to the system clipboard |
| `/om:compact` | Force a compaction now (idle only, no resume) |
| `/om:consolidate` | Force observer → reflector → dropper now |
| `/om:model [provider/model[:thinking] \| clear]` | Pick the worker model (picker when bare); writes `observational-memory.model` and reloads |
| `/om:factor` | (separate `om-factor` extension) set `compactAfterTokensRatio` |

## Configuration

Namespace `observational-memory` in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`.
All elpapi42 keys are unchanged. New:

```jsonc
{
  "observational-memory": {
    "tailTokens": 20000,
    "resumeAfterMidRunCompaction": true
  }
}
```

## Data handling and privacy

Workers send conversation chunks and current memory to the selected model/provider for
processing (the session model unless a worker model is configured). Provider retention and
processing policies apply; session-ledger storage does not imply local-only processing.

Memory and worker costs are recorded as `om.*` session entries. With `debugLog: true`
(default `false`), diagnostic events are also written under the Pi agent directory to
`observational-memory/debug/<session-id>.ndjson`, or `observational-memory/debug.ndjson`
when no usable session id is available. Logs include session paths/identifiers, working
directory and event data, and rotate to a `.1` file at the size limit.

`/om:model` persists the worker model selection in the agent directory's `settings.json`
and reloads; `/om:factor` similarly persists compaction settings. These settings updates
are separate from session memory.

`/om:view` automatically attempts clipboard copying on every valid invocation, including
`full`; there is no separate opt-in. Copying uses available platform clipboard utilities
and reports success or failure. Clipboard contents may be accessible to other applications
or clipboard-history/sync services. This extension does not guarantee that memory remains
exclusively in session files or that no external copies exist.

## Development

```bash
cd ../..
npm ci
npm run typecheck:memory
npm run test:memory
```

Ships as TypeScript; the root Pi manifest loads `src/index.ts` directly.
Development dependencies and centralized tests are owned by the package root.
No nested production install is required.
