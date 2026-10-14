# PROTOTYPE: Pi in VS Code editor tabs (throwaway)

Question: can the full Pi TUI run in a VS Code editor tab through our own xterm.js webview (node-pty → postMessage → xterm.js with WebGL) with acceptable latency, so every extension keeps working without the integrated terminal?

Run:

```sh
cd apps/pi-xterm-prototype && npm install && npm start
```

In the Extension Development Host, open the **Pi** activity bar view and click `+`, or run **Pi: New Session**.

What to check:

- Typing latency and scroll/redraw smoothness compared with WezTerm and the integrated terminal (`piXterm.renderer`: `webgl` | `dom`)
- Keys: Shift+Enter, Alt+Enter, Ctrl+P/O/C, Esc, Cmd+V, image paste, Cmd+C on a selection
- `ask_user_question`, the bash-guard overlay, `/usage`, the statusline footer
- Attention: the `❓`/`✓` markers on tabs and in the sidebar, plus notifications when the tab is not focused
- Links: URLs and `path/to/file.ts:12` open in VS Code

Sessions: closed tabs stay in the sidebar as history (newest 15 per workspace, plus "N more…"). The search icon searches every Pi session; picking one reopens it with `pi --session`. A small bridge extension (`pi/vscode-bridge.ts`, loaded with `-e` only in these tabs) tells each tab its current session file, so `/new` and `/resume` are tracked.

Known gap: subagents need a multiplexer (cmux/tmux/zellij/wezterm), so the subagent tool won't work here.
