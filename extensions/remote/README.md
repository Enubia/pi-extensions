# remote

Exposes a running Pi session to [`pi-remote`](../../apps/pi-remote/README.md) over a local Unix socket. TUI sessions only. Nothing is started until the session starts and nothing listens on the network.

## Socket

`~/.pi/agent/remote/<pid>.sock` (override the directory with `PI_REMOTE_DIR`). The directory is `0700`, the socket `0600`. It is created at session start and removed at session end; a stale socket from a crashed process is replaced on the next start with that pid and cleaned up by the hub when connections are refused.

## Protocol

Newline-delimited JSON, version `1` (`v` on every message; an unknown version gets `error` with code `incompatible`). Types are in [`protocol.ts`](protocol.ts). Multiple clients may connect.

| Direction | Messages |
| --- | --- |
| Session → client | `hello` (sent on connect: pid, session id, label, cwd, state, last activity, subagent/parent), `state`, `label`, `entry`, `text_delta`, `snapshot_result`, `ack`, `question`, `question_closed`, `error` |
| Client → session | `snapshot` (page back with `before`, `limit` default 50), `send` (`auto` or `followUp`), `abort`, `answer` |

States: `busy`, `input` (waiting on `ask-user-question`), `tui-dialog`, `idle`. Transcript entries are condensed to `user`, `assistant` and `tool` with stable ids, so live updates and snapshots upsert by id. Request messages carry an `id`, answered by `ack`, `snapshot_result` or `error`.

`ask-user-question` publishes its open question through [`question-events.ts`](../question-events.ts); an `answer` resolves it as if answered in the TUI.
