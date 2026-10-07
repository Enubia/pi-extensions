# Pi extensions

My personal [Pi](https://github.com/earendil-works/pi) extensions. The defaults (models, providers, thresholds, optional tools such as cmux and language servers) match my own setup. Copy whatever helps, and let your agent adjust the defaults to yours. There is no support commitment.

## Extensions

| Extension | What it does |
| --- | --- |
| `ask-user-question` | Tool that lets the agent ask the user structured questions |
| `bash-guard` | Guards agent `bash` calls, stricter for subagents |
| `attention-notify` | cmux or WezTerm notification when the agent asks a question; WezTerm also notifies when the main agent finishes |
| `lsp` | Language-server diagnostics, hover, definitions, references, symbols |
| `observational-memory` | Session-ledger memory with mid-run compaction |
| `provider-failover` | Switches provider on quota or transient failures, switches back after cooldown |
| `session-namer` | Auto-names sessions with a small model |
| `statusline` | Claude Code-style status line |
| `subagent-models` | Remaps subagent models to the session's current provider |
| `usage` | `/usage` shows Anthropic/OpenAI subscription quotas |

Some extensions have their own README with configuration details.

## Install

```sh
pi install git:github.com/Enubia/pi-extensions
```

## Development

Requires Node.js 22.19+.

```sh
npm ci
npm test
npm run typecheck && npm run typecheck:memory
```

## License

MIT. `observational-memory` is derived from [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) and [amosblomqvist/pi-observational-memory](https://github.com/amosblomqvist/pi-observational-memory), both MIT; see its `NOTICE`.
