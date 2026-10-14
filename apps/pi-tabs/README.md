# Pi Tabs

Run the [Pi](https://github.com/earendil-works/pi) coding agent in VS Code editor tabs instead of the integrated terminal. Each tab is a real terminal (node-pty → webview → xterm.js with WebGL), so the full Pi TUI and every Pi extension keep working.

## Requirements

- `pi` on the `PATH` of your login shell (or set `piTabs.command`)
- macOS (Linux should work but is untested; Windows is not supported)

## Features

- **Sessions sidebar**: each workspace lists its open Pi tabs, then its 15 most recent past sessions, plus "N more…". Closing a tab keeps the session in history.
- **Search and reopen**: the search icon searches every Pi session by name, folder and first message. Picking one reveals its tab or reopens it with `pi --session`. `/new` and `/resume` inside a tab are tracked through a small bridge extension (`pi/vscode-bridge.ts`) that is loaded only in these tabs.
- **Subagent tabs**: with [pi-interactive-subagents](https://github.com/Enubia/pi-interactive-subagents), subagents open as tabs in the editor group beside their parent and nest under it in the sidebar. The group closes when its last subagent tab does. Subagent sessions are hidden from history and search.
- **Attention**: with [attention-notify](https://github.com/Enubia/pi-extensions/tree/main/extensions/attention-notify), tabs and the sidebar show `❓` when Pi needs input and `✓` when it finished, plus a VS Code notification if the tab is not focused. Tabs also show a spinner while Pi works.
- **Paste**: Cmd+V reads the clipboard in the extension host, so dictation tools that send a synthetic Cmd+V work.
- **Shortcuts**: Cmd+Alt+N (Ctrl+Alt+N) opens a new session. Inside a tab, F1 and Cmd shortcuts (except Cmd+A/C/V) go to VS Code, so the command palette, quick open and tab switching keep working.
- **Links**: URLs and `path/to/file.ts:12` open in VS Code.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `piTabs.command` | `pi` | Command started in each tab, through your login shell |
| `piTabs.macOptionIsMeta` | `false` | Treat Option as Meta |
| `piTabs.fontFamily` / `piTabs.fontSize` | terminal font | Falls back to `terminal.integrated.*`, then `editor.*` |
| `piTabs.renderer` | `webgl` | `webgl` or `dom` |

Environment variables from WezTerm, tmux, zellij and cmux are removed in these tabs, so subagents never open in another terminal.

## Caveat

Opening the same session in two places (another tab, another window, a terminal) does not corrupt it, but each process only sees its own messages, so the session branches. Pick the branch later with `/tree`.

## Development

```sh
cd apps/pi-tabs
npm install
npm start                   # Extension Development Host
npm run install-extension   # build pi-tabs.vsix and install it (VSCODE_PROFILE=<name> for another profile)
npm run publish             # manual publish (needs `npx vsce login Enubia` once)
```

Releases are automatic: every push to `main` that touches `apps/pi-tabs` runs `.github/workflows/pi-tabs-release.yml`. It bumps the version from the commit messages since the last `pi-tabs-v*` tag (`feat` → minor, `!`/`BREAKING CHANGE` → major, anything else → patch), updates `CHANGELOG.md`, publishes to the Marketplace, and tags and creates a GitHub release with the `.vsix`. Run it manually from the Actions tab to force a bump. Needs the `VSCE_PAT` repository secret.
