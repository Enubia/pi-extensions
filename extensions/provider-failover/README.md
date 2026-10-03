# provider-failover

Switches the session to another provider when the current one hits a quota, transient, or
model-unavailable failure, then switches back when the cooldown expires.

Targets come from `subagent-models.json` — the same tier profiles the `subagent-models` extension uses.
The failing model's tier is reverse-looked-up and matched in the next profile (`anthropic` capable →
`openai-codex` capable), so session and subagent models stay in step: after the switch, new subagent
spawns follow the new provider automatically.

## Behaviour

1. `after_provider_response` records the last HTTP status and headers.
2. An assistant message ending with `stopReason: "error"` is classified: `quota` (429, usage/billing
   wording), `transient` (5xx, 529, overloaded, network), `unavailable` (404, unknown model), or `ignore`
   (aborts, context overflow — never triggers a switch).
3. The failing provider gets a cooldown: the reset time from `retry-after` /
   `anthropic-ratelimit-*-reset` / `x-ratelimit-reset-*` / `x-codex-*-reset-after-seconds` headers when
   available, otherwise `defaultCooldownMinutes` (15).
4. The next usable profile at the same tier wins — cooling-down providers and models without configured
   auth are skipped, and a missing tier degrades to the nearest cheaper one. Profiles wrap around.
5. Compaction runs first if the target's context window is smaller than the current usage.
6. Unless `retry` is off, a follow-up message asks the agent to retry the interrupted request.
7. When the origin provider's cooldown expires (checked at `agent_settled` and session start), the original
   model and thinking level are restored.

Cooldowns and the origin model live in `~/.pi/agent/provider-failover-state.json`, so a cooldown learned in
one session is respected by the next. Subagents (`PI_SUBAGENT_DEPTH >= 1`) never fail over on their own.

## Command

`/failover` — show the active model, origin, and remaining cooldowns.
`/failover now` — force a failover (useful for testing).
`/failover back` — restore the origin model and clear cooldowns.
`/failover clear` — clear cooldowns only.

The statusline shows `⇄ failover <time-left>` while failed over.

## Settings

Optional `"provider-failover"` block in `~/.pi/agent/settings.json` (or project `.pi/settings.json`):

```jsonc
{
  "provider-failover": {
    "enabled": true,
    "retry": true,
    "defaultCooldownMinutes": 15,
    "kinds": ["quota", "transient", "unavailable"]
  }
}
```

## Tests

```bash
node test/support/run-tests.mjs test/provider-failover/core.test.ts
```
