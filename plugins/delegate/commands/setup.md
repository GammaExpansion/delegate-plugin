---
description: Check whether the Codex and Antigravity CLIs are installed and ready
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup`

Show the output to the user. For any backend that is not ready, repeat the hint printed under it.

Do not install anything or run a login command yourself. Logging in is interactive, so tell the user to run it in their own terminal.
