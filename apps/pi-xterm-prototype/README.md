# Pi in VS Code editor tabs

A VS Code extension that runs the full Pi TUI in editor tabs instead of the integrated terminal: node-pty → webview → xterm.js (WebGL). Every Pi extension keeps working because it is still a real terminal.

## Install

```sh
cd apps/pi-xterm-prototype && npm install && npm run install-extension
```

This builds `pi-xterm.vsix` and installs it into the `work` VS Code profile (override with `VSCODE_PROFILE=<name>`). Re-run after changes, then reload the window. Uninstall: `code --uninstall-extension enubia.pi-xterm-prototype --profile work`.

For development, `npm start` opens an Extension Development Host.

## Usage

Open the **Pi** activity bar view and click `+`, or run **Pi: New Session**. Settings live under `piXterm.*` (command, font, `macOptionIsMeta`, renderer `webgl` | `dom`).

- **Sessions**: each workspace lists its open tabs, then its 15 most recent past sessions, plus "N more…". The search icon searches every Pi session; picking one reveals its tab or reopens it with `pi --session`. A small bridge extension (`pi/vscode-bridge.ts`, loaded with `-e` only in these tabs) tells each tab its current session file, so `/new` and `/resume` are tracked.
- **Subagents**: each tab gets a unix socket (`PI_VSCODE_SOCKET`). The `vscode` backend of [pi-interactive-subagents](https://github.com/Enubia/pi-interactive-subagents) uses it to open subagent tabs in the editor group beside the parent; they nest under the parent in the sidebar, and the group closes when its last subagent tab does. Subagent sessions are hidden from history and search. WezTerm/tmux/zellij/cmux env vars are stripped so subagents never escape into another terminal.
- **Attention**: `attention-notify` signals the tab through `pi_attention` user vars. Tabs and sidebar show `❓`/`✓`, and VS Code shows a notification when the tab is not focused. These sessions stay out of the menu bar app.
- **Paste**: Cmd+V reads the clipboard in the extension host, so dictation tools that send a synthetic Cmd+V work.
- **Links**: URLs and `path/to/file.ts:12` open in VS Code.

## Caveat

Opening the same session in two places (another tab, another window, WezTerm) does not corrupt it, but each process only sees its own messages, so the session branches. Pick the branch later with `/tree`.
