# attention-notify

Tells you when a TUI session needs you. "Needs input" fires when `ask_user_question` starts. "Done" fires when the main agent settles; subagents are skipped.

| Signal | When | Terminal |
| --- | --- | --- |
| Beep | Needs input, done | WezTerm (macOS) |
| Notification | Needs input | cmux (`cmux notify`) |
| `pi_attention` user var | Needs input, done | WezTerm |
| Attention record | Needs input, done | Any, only if `~/.pi/agent/attention/` exists |

All signals clear when the question is answered, the next prompt starts, or the session ends.

## WezTerm user var

The extension sets the pane user var `pi_attention` to `input:<ms>`, `done:<ms>`, or an empty string. The timestamp makes every event distinct, so the WezTerm config can track which events you have already seen. My config uses it to mark tabs with `?`/`✓`, list other workspaces that need attention in the right status, and hide a marker once you focus its pane.

## Attention records

For the [menu bar app](../../apps/attention-bar/README.md). Each session writes `pane-<WEZTERM_PANE>.json` (or `pid-<pid>.json` outside WezTerm) to `~/.pi/agent/attention/`, overridable with `PI_ATTENTION_DIR`:

```json
{ "pid": 4242, "state": "input", "token": "input:1730000000000", "label": "release prep", "question": "Ship it?", "cwd": "/work", "weztermPane": 7, "updatedAt": 1730000000000 }
```

`token` matches the `pi_attention` user var, so the WezTerm config can delete the record once the pane has been focused.
