# subagent-models

Remaps the model of every `subagent` spawn to the provider the main session is currently on.

Agent definitions (`~/.pi/agent/agents/*.md`) keep their canonical `model:` frontmatter. This extension
intercepts the `subagent` tool call and mutates `input.model` before the spawn — the subagent tool prefers
an explicit `model` param over the agent's frontmatter, so the override wins.

## Resolution order

1. `cli:` agents (e.g. `claude-code`) are never touched.
2. Caller passed a tier token (`standard`, `tier:capable`) → that tier.
3. Caller passed a concrete model → reverse-lookup its tier in any profile, remap to the active profile.
   An unknown explicit model is left alone.
4. Agent name matches a `roles` entry → that tier.
5. Agent frontmatter model → reverse-lookup its tier, remap.
6. Neither → the profile's `defaultTier`.

A tier missing from the active profile is skipped rather than downgraded. Thinking level comes from the
role, then the tier; it is appended as `model:thinking` only when the agent's frontmatter has no `thinking:`
(frontmatter wins downstream anyway).

Thinking levels are the seven canonical pi levels — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` —
validated on load. Support is per model (`claude-haiku-4-5` tops out at `high`; `claude-sonnet-5`,
`claude-opus-5`, `claude-fable-5-1`, and the codex models take `xhigh`/`max`), so the editor only offers the
levels `getSupportedThinkingLevels()` reports and `/subagent-models` flags a configured level the model
cannot honour (pi clamps it).

## Config

`~/.pi/agent/subagent-models.json`, or `<cwd>/.pi/subagent-models.json` to override per project:

```jsonc
{
  "fallbackProfile": "anthropic",       // used when no profile claims the session provider
  "roles": { "scout": "cheap", "worker": { "tier": "standard", "thinking": "minimal" } },
  "profiles": {
    "anthropic": {
      "providers": ["anthropic"],       // session providers this profile claims
      "defaultTier": "cheap",
      "tiers": { "standard": { "model": "anthropic/claude-sonnet-5", "thinking": "high" } }
    }
  }
}
```

Tiers: `cheapest`, `cheap`, `standard`, `capable`, `frontier`.

## Command

`/subagent-models` opens a menu:

- **Show resolved profile** — tier/model table, which roles map to each tier, config path, thinking warnings.
- **Pin profile** — override the session-provider match (`auto` to unpin). Session-local.
- **Edit roles** — pick an agent (discovered from `agents/*.md` plus existing roles), pick a tier or unmap it,
  pick a thinking level or inherit the tier's.
- **Edit tiers** — pick a profile, a tier, then a model from the authenticated registry (providers of that
  profile first) or a hand-typed `provider/id`, then a supported thinking level. Writes back to the config file.
- **Edit default tier** — pick a profile (automatically selected when there is only one), then one of its
  configured tiers. The current default and each tier's model/thinking are shown. Back/Escape makes no change.
  The default applies only when no explicit model, role, or agent model supplies a tier; named-role defaults remain unchanged.

Direct forms still work: `/subagent-models anthropic`, `/subagent-models auto`, `/subagent-models edit`.
Every write is re-validated with `parseConfig` before it lands, and the file is replaced atomically.

## Tests

```bash
node test/support/run-tests.mjs test/subagent-models/*.test.ts
```
