# Pi Tabs

Run [Pi](https://github.com/earendil-works/pi) in VS Code editor tabs instead of the terminal panel. It's the real Pi TUI, so your Pi extensions keep working.

## Getting started

1. Make sure `pi` runs in your login shell (or point `piTabs.command` at it).
2. Open **Pi Tabs** in the activity bar, or press `Cmd+Alt+N` (`Ctrl+Alt+N`).

Built for macOS. Linux may work but is untested; Windows is not supported.

## Features

- **Sessions sidebar**: open tabs and recent sessions for each workspace. Closing a tab keeps the session.
- **Search**: find any Pi session by name, folder or first message and reopen it.
- **VS Code shortcuts work in tabs**: command palette, quick open, switching tabs.
- **Clickable links**: URLs and `file.ts:12` open in the editor.
- **Working indicator**: a spinner on the tab while Pi is busy.

## Works well with

- [pi-interactive-subagents](https://github.com/Enubia/pi-interactive-subagents): subagents open as tabs next to their parent and nest under it in the sidebar.
- [attention-notify](https://github.com/Enubia/pi-extensions/tree/main/extensions/attention-notify): tabs show `❓` when Pi needs you and `✓` when it's done, with a notification if you're looking elsewhere.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `piTabs.command` | `pi` | Command to run in each tab |
| `piTabs.fontFamily`, `piTabs.fontSize` | your terminal font | |
| `piTabs.macOptionIsMeta` | `false` | Use Option as Meta |
| `piTabs.renderer` | `webgl` | Switch to `dom` if rendering looks off |

## Good to know

Opening the same session twice (two tabs, or a tab and a terminal) branches it. Use `/tree` in Pi to pick a branch.

