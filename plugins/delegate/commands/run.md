---
description: Hand a task to Codex or Antigravity and show its answer
argument-hint: "<codex|agy> [--worktree] [--background] [--permission <option>] [--sandbox enabled|disabled] [--model <id>] [--effort <level>] <task>"
allowed-tools: mcp__delegate__codex, mcp__delegate__agy, mcp__delegate__wait
---

Hand this request to a delegate with its tool.

Raw request:
$ARGUMENTS

Choosing the tool:

- The first word names the backend. `codex` means `mcp__delegate__codex`. `agy`, `antigravity` or `gemini` means `mcp__delegate__agy`.
- If no backend is named, ask the user which one they want before doing anything else.
- If neither tool is available, the plugin's mod is not loaded: tell the user that delegate needs a Claude Code that runs mods, with mods allowed, and stop.

What to pass:

- `--permission`, `--sandbox`, `--model` and `--effort` go in the tool's fields of the same names, as the user typed them. `--worktree` is `worktree: true` and `--background` is `background: true`.
- If the user typed no `--permission`, choose the one that matches this conversation's permission mode, as the `delegating-tasks` skill says.
- `task` is the rest of the request. The delegate cannot see this conversation. If the task refers to something only this conversation knows ("that bug", "the file we were looking at"), replace the reference with the concrete file paths, error text and goal. Change nothing else about the task.
- If the user means to continue an earlier delegate conversation from this session, pass the `session` from that conversation's latest result.
- If the user gave no task text, ask what the delegate should do.

Afterwards:

- The result is a few lines on how the turn ended, then the delegate's answer. Show the answer to the user as it is, under the first line of the result.
- After a background start, say that the delegate is running and that its answer will follow.
- Stop there. Do not apply the delegate's suggestions or continue its work unless the user asks.
- If the result says a backend is missing or not logged in, point the user to `/delegate:setup`.
