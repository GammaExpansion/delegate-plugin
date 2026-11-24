---
description: Hand a task to Codex or Antigravity
argument-hint: "<codex|agy> [--worktree] [--model <id>] [--effort <level>] [--permission <option>] [--sandbox enabled|disabled] [--resume <session id>] <task>"
allowed-tools: Agent
---

Start a delegate subagent with the `Agent` tool for this request.

Raw request:
$ARGUMENTS

- The first word names the backend: `codex` means `subagent_type: "delegate:codex"`; `agy`, `antigravity` or `gemini` means `subagent_type: "delegate:agy"`. If no backend is named, ask the user which one before doing anything else.
- `--worktree` is for you: start the subagent with `isolation: "worktree"` and leave the flag out of the prompt. Without it, do not isolate the subagent.
- The prompt is `--model`, `--effort`, `--permission`, `--sandbox` and `--resume` on its first line, as the user typed them, then the task. `--resume <session id>` continues a conversation from an earlier Claude session, by the id on a report's `session:` line: it needs a new subagent, not SendMessage. Without `--permission` and `--sandbox`, what a delegate may do follows this conversation's permission mode; with them, the user is asked before the delegate gets more than that mode gives.
- The delegate cannot see this conversation. Replace references to it ("that bug", "the file we were looking at") with the concrete paths, error text and goal. Change nothing else about the task. If there is no task, ask what the delegate should do.
- Start the call's `description` with `Codex Agent` or `Gemini Agent`, then the task in a few words.
- If the user means to continue an earlier delegate conversation from this session, send the request to that subagent with SendMessage instead of starting a new one.

When the report arrives, show the delegate's answer to the user under its headline, and stop there: do not apply its suggestions unless the user asks.
