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
| `/om:factor [ratio \| percent \| reset]` | Pick or save a global compaction ratio for the currently selected provider; reset removes only that provider's global override; reloads |

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

`agentMaxRetries` (default `3`, non-negative integer; `0` disables, invalid values fall back to the default) retries the observer, reflector and dropper on transient provider errors (429, 5xx, overloaded, network, timeout) with exponential backoff of 2s/4s/8s ±20% jitter. Deliberate empty results, validation rejections, aborted streams and non-retryable errors are never retried, and remaining attempts are cancelled if memory is turned off or the session changes. Cost of failed attempts still counts toward `om.cost`; `/om:status` last errors include the attempt count and `debugLog` records a `<stage>.retry` event per attempt.

`observerRedactSkillReads` (default `true`) replaces the result of a `read` of a skill file (basename `SKILL.md`, or any path with a `skills/` directory segment) with `[skill file <path> loaded; content omitted]` in the text sent to the observer; the tool call line stays. `observerDedupeToolResults` (default `true`) replaces a tool result whose text is identical to an earlier result in the same observer chunk with `[identical to source entry <id>]`. Both apply only to observer input: recall, progress clocks and the ledger keep raw content, and chunk token budgeting uses the reduced size. `debugLog` records `redactedEntries` and `collapsedEntries` in `observer.start`.

### Provider compaction factors

`/om:factor 0.5`, `/om:factor 50%`, and `/om:factor 50` save the same global override across codebases for the exact selected `ctx.model.provider`. Bare invocation opens a picker; `/om:factor reset` removes that provider's global override. These commands change only `compactAfterTokensRatioByProvider`, never scalar defaults or session state. No model-specific settings or routing/provider guesses are used.

```json
{
  "observational-memory": {
    "compactAfterTokensRatioByProvider": {
      "openai-codex": 0.5,
      "anthropic": 0.15
    }
  }
}
```

Map values must be finite numbers strictly between 0 and 1; invalid entries are ignored. Provider IDs match exactly (for example, `openai` differs from `openai-codex`). Resolution is scope-first: project provider ratio → explicit valid project scalar compaction settings → global provider ratio → existing merged scalar defaults. Partial scalar settings retain their previous independent merging; a ratio-only scalar does not enable ratio mode. Existing calibrated mode, ratios and token fallbacks remain unchanged.

Model/provider switches reevaluate the policy without reload. Ratio thresholds prefer the effective context usage window, then the selected model window; unknown windows fall back to `compactAfterTokens`. Trigger, status, footer and picker use the same resolution. The factor measures post-compaction context growth (raw estimate as fallback), not a hard total-context ceiling; Pi's own compaction safeguards remain independent. The command reports global/provider scope and warns when project settings mask the saved override. Manually edited settings still require reload. OM retains its existing direct project-settings reading behavior.

The old standalone `om-factor` entrypoint is a deprecation-only shim. Explicit installations must enable OM and retire the old resource; it does not register commands or automatically load OM. Root package filters must select OM, not the retired factor factory.

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
and reloads; `/om:factor` persists only the selected provider's global compaction ratio override. These settings updates
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
