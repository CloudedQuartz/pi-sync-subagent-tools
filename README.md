# Sync Subagent Tools

A Pi extension that adds `/sync-subagent-tools` in the interactive TUI. It syncs Pi's available tool names into the managed `tools:` frontmatter of every agent discovered in Pi's global agent directory.

## Install and use

Before installing, move or remove the existing local extension at `~/.pi/agent/extensions/sync-subagent-tools.ts` so Pi does not register the same command twice. This repository leaves that local file and `~/.pi/agent/settings.json` untouched.

```sh
pi install git:github.com/CloudedQuartz/pi-sync-subagent-tools
```

In Pi's TUI, run `/sync-subagent-tools`. The command is deliberately unavailable in print, JSON, and RPC modes. At each invocation it discovers direct regular `.md` files in `~/.pi/agent/agents`; it does not recurse into subdirectories or follow symlinks. Valid unmarked frontmatter is enrolled automatically: an existing `tools:` line is wrapped in managed markers, or a managed `tools:` line is inserted when absent. Malformed frontmatter, malformed markers, or case-insensitive filename collisions stop synchronization before any files are changed. The command updates only the managed `tools:` frontmatter.

## Managed tools

All discovered agents receive the sorted union of the bootstrap tool set, tools already managed by any discovered agent, and Pi's current live tool catalog. The pi-subagents recursive tools remain forcibly excluded.
