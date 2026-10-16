# pi-remote

Watch and steer your running Pi sessions from a phone or tablet on the same Wi-Fi. A small hub on your Mac serves a web page; the `remote` extension in each Pi session exposes a local socket the hub talks to.

Requires Node.js 24.12+ and `npm ci` in the repo root.

```sh
apps/pi-remote/install.sh    # symlinks ~/.local/bin/pi-remote
apps/pi-remote/uninstall.sh  # removes that symlink only if it points at this repo
```

`~/.local/bin` must be on your `PATH`. Sessions started before the `remote` extension was installed need `/reload`.

## Usage

```sh
pi-remote [--port N] [--for DURATION]
```

| Flag | Default | |
| --- | --- | --- |
| `--port` | `7317` | HTTP port; `0` picks a free one |
| `--for` | none | Stop after this long: `30m`, `2h`, `1h30m`, `90s`, or bare minutes |

It prints a QR code, `http://<lan-ip>:<port>/#t=<token>` and `http://<LocalHostName>.local:<port>/#t=<token>`. Scan the QR with the phone. Ctrl+C stops it. While running it holds `caffeinate -i` so the Mac stays awake, and logs an audit line per connection and per action (steer, prompt, followUp, answer, abort).

Only one hub runs per remote directory (`pi-remote.lock`). Remote directory: `~/.pi/agent/remote`, override with `PI_REMOTE_DIR` (hub and sessions must agree).

## What the page does

- Lists sessions by urgency: needs input, busy, idle. Subagents nest under their parent.
- Opens a session transcript with live updates, tool calls collapsed to one line (tap to expand), and "Load more" for history.
- Sends a message (steers when busy, prompts when idle, or "Queue after run"), aborts a run, and answers `ask-user-question` questions. Answering in the TUI first clears the phone question.
- Sessions waiting on a TUI dialog show a notice and no input box. Sessions on an older protocol show "incompatible, /reload".
- Chimes and sets the tab title to `(N) needs input` when a session needs input or a main session finishes. Browsers only allow audio after a tap, so tap the page once after opening it. On iOS the ringer switch must be on.

## Security model

Plain HTTP, no TLS. Anyone who can read your Wi-Fi traffic can read the token and everything shown.

- Per-run token: 32 random bytes, generated at start, new on every run. The QR URL carries it in the fragment, so the page load never sends it; the page then keeps it in `sessionStorage`, strips it from the address bar, and sends it as `?t=` on `/events` and as `Authorization: Bearer` on `/api/*`. Over plain HTTP anyone sniffing the Wi-Fi during the run can read it. `/events` and `/api/*` require it; the static page does not.
- Source filter: requests from non-private addresses get 403. Allowed: loopback, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, IPv6 `::1`, `fc00::/7`, `fe80::/10`. The filter checks the socket address and does not understand proxies.
- The hub binds all interfaces (dual-stack), so it is reachable on any network the Mac is on. Do not run it on untrusted Wi-Fi.
- Per-session sockets are `0600` in a `0700` directory, so only your user can reach them.

While running, anyone on the LAN who obtains the token (shoulder-surfing the QR, a screenshot, sniffing the plain HTTP) can read session transcripts, including tool arguments and command output; send prompts to any session, which means running tools as you; abort runs; and answer questions. Treat the token like a password: use `--for`, stop the hub when done, and do not share the QR.

## Troubleshooting

- `port N is already in use (use --port)`: another process holds the port.
- `already running, pid X`: another hub uses the same remote directory.
- No sessions listed: check the session has the `remote` extension loaded (`/reload`), runs in a TUI, and shares `PI_REMOTE_DIR`.
- `.local` URL fails on the phone: use the IP URL.
