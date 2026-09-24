# Sync Subagent Tools

A Pi extension that adds `/sync-subagent-tools` in the interactive TUI. It syncs Pi's available tool names into the managed `tools:` frontmatter of six custom agents.

## Install and use

Before installing, move or remove the existing local extension at `~/.pi/agent/extensions/sync-subagent-tools.ts` so Pi does not register the same command twice. This repository leaves that local file and `~/.pi/agent/settings.json` untouched.

```sh
pi install git:github.com/CloudedQuartz/pi-sync-subagent-tools
```

In Pi's TUI, run `/sync-subagent-tools`. The command is deliberately unavailable in print, JSON, and RPC modes. It updates only the managed tools block in these agent files:

- `Adversarial.md`
- `Bounded-advisor.md`
- `Explore.md`
- `Implement.md`
- `Review.md`
- `Verify.md`

## Current managed allowlist

All six agents currently have this identical managed line:

```text
tools: advisor, ask_user_question, ast_grep_outline, ast_grep_replace, ast_grep_search, bash, document_parse, document_screenshot, document_search, edit, effective_config, fetch_content, find, get_search_content, grep, lens_diagnostic_mark, lens_diagnostics, ls, lsp_navigation, module_report, pi_lens_activate_tools, powershell, preview_export, project_report, read, read_enclosing, read_symbol, source_check, symbol_search, todo, web_search, write
```
