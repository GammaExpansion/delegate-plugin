---
description: Cancel a running delegate job
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" cancel "$ARGUMENTS"`

Report the outcome in one line.
