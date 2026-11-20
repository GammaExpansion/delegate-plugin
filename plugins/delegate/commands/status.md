---
description: Show running and recent delegate jobs for this workspace
argument-hint: "[job-id] [--all]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" status "$ARGUMENTS"`

If no job id was given, show the output as one compact Markdown table and nothing else.

If a job id was given, show the full output unchanged.
