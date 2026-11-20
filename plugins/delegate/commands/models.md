---
description: List the models each delegate backend can run
argument-hint: "[codex|agy]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" models "$ARGUMENTS"`

Show the output to the user unchanged, in a code block. The ids in the first column are what `--model` accepts.
