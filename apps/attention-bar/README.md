# Pi Attention menu bar app

A macOS menu bar item that lists Pi sessions waiting for input (`?`) or finished (`✓`). Requires macOS 13+ and Swift.

```sh
apps/attention-bar/install.sh    # builds, installs ~/Applications/Pi Attention.app, starts it at login
apps/attention-bar/uninstall.sh
```

## How it works

The app creates `~/.pi/agent/attention/` (override with `PI_ATTENTION_DIR`). The `attention-notify` extension writes one JSON record per session there only if that directory exists, so nothing is written unless the app has been installed. Records are named `pane-<WEZTERM_PANE>.json` or `pid-<pid>.json` and are removed when the question is answered, the next prompt starts, or the session ends. The app also drops records whose process has exited.

Clicking an entry brings WezTerm to the front. A finished entry is removed on click.

## WezTerm integration

For click-to-jump and clearing an entry when you focus its pane, the WezTerm config needs an `update-status` handler that:

- reads `~/.pi/agent/attention/focus-request` (a pane id), deletes it, switches to that pane's workspace, and activates the tab and pane;
- when the focused pane's `pi_attention` user var changes, deletes `pane-<id>.json` if its `token` matches the user var.
