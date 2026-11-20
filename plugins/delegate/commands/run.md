---
description: Hand a task to Codex or Antigravity and show its answer
argument-hint: "<codex|agy> [--worktree] [--permission-mode <mode>] [--model <id>] [--effort <level>] <task>"
allowed-tools: Agent, Bash(node:*)
---

Route this request to a delegate subagent with the `Agent` tool.

Raw request:
$ARGUMENTS

Choosing the subagent:

- The first word names the backend. `codex` means `subagent_type: "delegate:codex"`. `agy`, `antigravity` or `gemini` means `subagent_type: "delegate:agy"`.
- If no backend is named, ask the user which one they want before doing anything else.
- These are subagents, not skills. Call them with `Agent`, never with `Skill`.
- Start the `description` of the `Agent` call with `Codex Agent` or `Gemini Agent`, then the task in a few words, such as `Codex Agent: review token refresh`. If the user named a model, put it in: `Gemini Agent (gemini-3.8-flash-low): explain math.js`. It is what the user sees while the delegate works.

Worktree:

- `--worktree` in the request is addressed to you, not to the subagent. Start the subagent with `isolation: "worktree"` on the `Agent` call and remove the flag from what you forward.
- Without `--worktree`, do not isolate the subagent. It works in the current directory.

What to forward:

- Forward everything after the backend name as the subagent's prompt, flags included. The subagent turns `--permission-mode`, `--model` and `--effort` into runtime options. Do not add a `--permission-mode` the user did not type: without one, the delegate follows this conversation's permission mode.
- If the user means to continue an earlier delegate conversation from this session, do not start a new subagent. Continue the subagent that held that conversation by sending it the new request.
- The delegate cannot see this conversation. If the task refers to something only this conversation knows ("that bug", "the file we were looking at"), replace the reference with the concrete file paths, error text and goal. Change nothing else about the task.
- If the user gave no task text, ask what the delegate should do.

If the user does not want to wait for the answer, run the subagent in the background. There is no separate background mode: the subagent reports back when the delegate has finished.

Afterwards:

- Show the subagent's output to the user as it came back.
- Stop there. Do not apply the delegate's suggestions or continue its work unless the user asks.
- If the output says a backend is missing or not logged in, point the user to `/delegate:setup`.
