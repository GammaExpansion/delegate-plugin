# delegate

Hand a task from Claude Code to another vendor's coding agent and get the result back. Two backends are supported:

| Backend | CLI | Protocol |
|---|---|---|
| `codex` | OpenAI Codex | `codex app-server` (stdio JSON-RPC) |
| `agy` | Google Antigravity | `agy acp` (Agent Client Protocol) |

The plugin stores no credentials. It uses the login and configuration that each CLI already has on this machine.

## Install

Requires Node.js 18.18 or later and at least one backend CLI that is installed and logged in.

Load it directly during development:

```bash
claude --plugin-dir /path/to/delegate-plugin/plugins/delegate
```

Or install it as a marketplace, from GitHub or from a local copy:

```text
/plugin marketplace add GammaExpansion/delegate-plugin
/plugin install delegate@delegate-marketplace
```

```text
/plugin marketplace add /path/to/delegate-plugin
/plugin install delegate@delegate-marketplace
```

Then run `/delegate:setup` to check that the backends are ready.

## Usage

Ask in plain language and Claude picks the subagent:

```text
Ask Codex whether the token refresh logic in src/auth.ts has a race condition
```

Or use the commands:

```text
/delegate:run codex find out why tests/session.test.ts fails intermittently
/delegate:run agy --permission-mode acceptEdits fix the bug in math.js
/delegate:status
/delegate:result task-abc123
/delegate:cancel task-abc123
/delegate:models
```

| Flag | Effect |
|---|---|
| `--permission-mode <mode>` | Sets what the delegate may do this turn, using Claude Code's mode names: `plan`, `default`, `dontAsk`, `acceptEdits`, `auto`, `bypassPermissions`. Left out, the turn follows the conversation's permission mode. See [Permission model](#permission-model). |
| `--worktree` | Only on `/delegate:run`. Runs the delegate in its own git worktree. Off by default. See [Worktrees](#worktrees). |
| `--model <id>` | Picks a model. Left out, the backend uses its own default. `/delegate:models` lists the ids each backend accepts. |
| `--effort <level>` | Picks a reasoning effort. |

## Conversations

A delegate behaves like any other Claude Code subagent:

- Each `delegate:codex` or `delegate:agy` subagent Claude starts is one conversation with that delegate.
- To follow up ("now apply the first fix you proposed"), Claude continues the same subagent. The delegate remembers the whole conversation.
- A new subagent is a new conversation. Several can run side by side.

Nobody has to keep track of ids. Under the hood the backend process exits after every turn, and the conversation lives in the backend's own session store. Each result prints that session's id, and the forwarding subagent, which still has its earlier results in context, passes it back with `--resume` on the next turn.

A conversation takes one turn at a time. Once its subagent is gone (the Claude Code session ended, for instance), the conversation can still be reopened by hand with `task --resume <session-id>`.

## Worktrees

By default a delegate works in the same directory as the conversation, like any subagent. Two delegates editing the same files, or a delegate and Claude, overwrite each other.

To give a delegate its own copy of the repository, ask for it ("have Codex do this in a worktree") or pass `--worktree` to `/delegate:run`. Claude then starts the subagent with Claude Code's own worktree isolation:

- Claude Code creates the worktree under `.claude/worktrees/` and a branch for it, and removes it again if the delegate changed nothing.
- The delegate works there for the whole conversation. Follow-ups to the same subagent stay in the same worktree.
- Every result names the worktree's path and branch. The edits stay there until that branch is merged. Merging is up to you.
- `/delegate:status`, `/delegate:result` and `/delegate:cancel` see the job from the main checkout as well, because jobs are grouped by repository, not by checkout.

What to know before using it:

- A worktree is a fresh checkout. Uncommitted changes in the main checkout are not in it. By default Claude Code starts it from the repository's default remote branch, so unpushed local commits are missing too. Set `worktree.baseRef` to `"head"` in Claude Code's settings to start from the current local commit. Files that git ignores are copied only if a `.worktreeinclude` file lists them.
- Codex cannot commit inside a worktree while it is sandboxed, which is every mode except `bypassPermissions`. A worktree's index lives in the main repository's `.git` directory, which is outside the sandbox. Its edits are left uncommitted in the worktree. agy can commit when its mode lets it run commands.
- It needs a git repository.

## How a task runs

Every task runs the same way:

1. The subagent calls `task`, which starts the delegate as a detached job and returns a job id at once.
2. The subagent calls `follow <job-id> --offset <n>` in a loop. Each call returns what the delegate did since the last one: commands and their output, file edits, interim messages, reasoning summaries. After each call the subagent writes a one-line progress note. If the delegate needs your permission, `follow` returns with the request, and the subagent puts it to you (see [Permission model](#permission-model)).
3. When the job has ended, `follow` prints the result and the subagent returns it unchanged.

`follow` returns when there is something to report, not on a timer. Once the delegate logs new activity, `follow` keeps collecting for a short settle window (6 seconds in a job's first minute, 15 up to five minutes, 30 after that) and returns that batch. If the delegate is silent it returns after 90 seconds. Progress therefore arrives in batches, not token by token.

The forwarding subagent keeps everything it reads in its context, and that context lasts for the whole conversation. So `follow` shows a compact view by default: reasoning entries are left out, only the last two lines of a command's output are kept, and interim messages are cut short. The full log stays on disk.

To watch a job yourself, run `follow --verbose` in a terminal or read the job log.

To keep working while a delegate runs, have Claude run the subagent in the background. Claude Code reports back when it finishes.

## Design decisions

### One way to run a task

There is no background mode and no blocking `wait` command. Both existed in an earlier version and were removed.

- **What it replaced.** The subagent used to run the delegate inside one blocking shell command. That command was bound by Claude Code's 10-minute limit, and nothing the delegate did was visible until it ended. Long tasks needed a second path: `--background` to detach the job, and `wait` to find out when it had finished.
- **Why one path is enough.** Following the job in short calls has no time limit and shows progress, which covers what the second path was for. Not blocking the main conversation is something Claude Code already does for any subagent, so the plugin does not need its own mechanism.
- **What it costs.** Each `follow` call is one call to the subagent's model, and the subagent's context grows with what it reads. A blocking `wait` used no model calls while the job ran. One path that always shows progress was judged worth more than a cheaper second path that has to be explained and chosen.

### A conversation is a subagent

Continuing a delegate conversation means continuing its subagent, exactly as with a native subagent. An earlier version had the main agent keep job ids and pass `--resume <id>` to a fresh subagent each turn.

- **Why.** The point of the plugin is that Codex and Antigravity can be used the way subagents are. Claude's habit is to continue a subagent by sending it a message. With a stateless forwarder that habit silently opened a new conversation, and the delegate had forgotten what came before, including any question it had just asked.
- **How.** The forwarding subagent's own context already holds every result it returned, and each result names the backend session. It is told to resume that session whenever one exists.
- **What it costs.** The forwarder's context now grows across the turns of a conversation where it used to start empty each turn. The compact `follow` view keeps that growth small, and Claude Code compacts a subagent's context by itself when it fills up.
- **What it gives up.** A conversation is tied to its subagent's lifetime. Reopening it later is possible but manual.

### Worktrees belong to Claude Code, and are off by default

The plugin creates no worktrees of its own. Isolation is the option Claude Code already has for any subagent, switched on per call.

- **Why not manage them in the script.** Claude Code already creates the worktree, keeps a continued subagent in it, reports its path and branch, and cleans it up. A second implementation would have to redo all of that, and would give the main agent one more flag to learn. It also fits the rest of the design: a delegate is a subagent, so it is isolated the way a subagent is.
- **Why off by default.** A worktree does not contain uncommitted work, and much of what a delegate is asked to do is to look at exactly that: review this change, diagnose this failing test. Isolation is for the other case, where a delegate edits while something else edits the same repository.
- **What the plugin had to change.** Job records used to be grouped by checkout, which hid a worktree's jobs from the main checkout. They are now grouped by repository.
- **What it gives up.** Isolation only exists inside Claude Code. A task started by hand runs wherever it was started.

### Permission requests go to the user

When a delegate wants something its mode does not already allow, the request is put to you through Claude Code's own permission dialog. An earlier version refused every such request, on the grounds that nobody could be asked in the middle of a delegated turn.

- **Why.** Refusing made the modes mean something different for a delegate than for Claude. `default` became read-only, agy could run no command at all below `auto`, and a refused `ls` was enough to end an agy turn with nothing to show. A native subagent asks you. A delegate should too.
- **How it can work at all.** Both backends wait for an answer as long as they have to, so the job can hold a request open. The plugin has no dialog of its own. It borrows Claude Code's: the subagent runs a command, and the hook has Claude Code ask you before that command runs.
- **Why the hook, and a secret.** The subagent that runs the command is a model reading another model's output. It must not be able to approve on your behalf. So an approval counts only with a mark that the hook attaches, and the hook attaches it only on the path where you are asked.
- **What it costs.** Every request is a round trip through the subagent's model and a click from you.
- **Where it stops.** `dontAsk` still refuses everything, because that is what the mode means, and a non-interactive run has nobody to ask.

### `follow` is driven by activity, not by a clock

The subagent's model can only act when a tool call returns, so the delegate cannot push a message to it. The nearest thing is a call that blocks until there is news. `follow` does that: the script watches the job log (cheap, no model involved) and returns only when the delegate has done something, when it has ended, or after 90 seconds of silence. A delegate that thinks quietly for five minutes costs three or four calls. A busy one costs at most one call per settle window.

### A job needs a follower

Every `follow` call marks the job as watched. A job that nothing has followed for 120 seconds interrupts its delegate and ends as cancelled.

- **Why.** The delegate runs in its own process, so interrupting the subagent, or closing Claude Code, would otherwise leave Codex or agy working, and possibly editing files, with nobody reading the result.
- **Why a lease and not a signal.** Nothing tells the script that the subagent was interrupted. The absence of `follow` calls is the only evidence there is.
- **The trade-off.** A delegate keeps running for up to two minutes after its subagent stops. Set `DELEGATE_LEASE_SEC` to change the window, or to `0` to turn it off. The conversation is kept either way and can be continued with `--resume`.
- **Sleep does not count.** While the machine is asleep the follower is frozen too. A job that notices it has been suspended starts a fresh window instead of stopping at once.

## Permission model

A delegate turn runs in one of Claude Code's own permission modes. The mode is decided when the turn starts:

1. `--permission-mode <mode>` on the task, if there is one. It overrides everything else. If it allows more than the conversation's mode, Claude Code asks you to approve it first.
2. Otherwise, the mode the Claude Code conversation is in at that moment.
3. Otherwise (a task started outside Claude Code, for instance), `default`.

A mode says what the delegate may do without asking. When it wants more, it asks, and the request comes to you, as it would from any subagent. The three vendors cut permissions differently, so a mode does not mean the same thing on each backend:

| Mode | Codex | Antigravity |
|---|---|---|
| `plan` | Its "Read Only": a read-only sandbox with no network. Commands that only read still run. It asks the user before a command that needs more. File edits are refused. | Its own plan mode: it researches, and writes a plan into its own data directory, outside the workspace. It asks the user before a command, and before reading outside the workspace. Edits are refused. |
| `default` | Its "Read Only", as above. It asks the user before an edit or a command that needs more. | It asks the user before every edit and every command. |
| `dontAsk` | The same sandbox, and nothing is asked: what the sandbox does not allow fails. | Reads and searches inside the workspace. Everything it asks about is refused. |
| `acceptEdits` | Its "Ask for approval": it edits files and runs commands inside a sandbox that can write only to the workspace and temp directories and has no network. It asks the user before stepping outside the sandbox or onto the network. | It edits files in the workspace. It asks the user before every command, and before touching anything outside the workspace. |
| `auto` | Its "Approve for me": as `acceptEdits`, but its own automatic reviewer answers its requests, not the user. | It edits files and runs commands inside its own sandbox. It asks the user about what it judges risky, and before leaving the sandbox. |
| `bypassPermissions` | Its "Full Access": no sandbox. It can edit any file your account can and use the network, and asks nothing. | Its `--dangerously-skip-permissions`, which its desktop app calls Turbo: it runs everything without asking, inside the workspace or not. |

### How a request reaches you

1. The delegate asks its own backend for permission, and the job holds the request without answering.
2. `follow` returns at once and shows the forwarding subagent what the delegate wants.
3. The subagent runs `companion.mjs answer <job> <request> allow`.
4. The plugin's hook turns that command into a question: Claude Code shows you what the delegate asked for, in the words of the job's own record.
5. If you approve, the command runs and the delegate goes ahead. If you refuse, the subagent records a refusal and the delegate is told no.

You have three answers, not two. Besides yes and no, you can refuse and say what to do instead, wherever Claude Code's dialog lets you add a reply to a refusal. The subagent passes your words on with the refusal:

- **Codex** gets them as a message into the turn it is running, and carries on from there. If that turn has just ended, they are sent as a turn of their own.
- **agy** takes no message with a refusal, and a refusal usually ends its turn. So the job sends your words as the next message of the same conversation, and agy carries on.

Things to know:

- **The approval is yours, not the subagent's.** An `allow` counts only with a mark the hook attaches after you have been asked, and the hook throws away any mark the subagent supplies. So while the hook runs, nothing is approved without your click. The request is shown to you as the job recorded it. A very long one is cut, and then says how much is missing.
- **That guarantee depends on the hook.** The mark is a file on this machine, readable by anything running as you, the subagent included. With the hook switched off, a subagent that went looking for it could approve its own request. An honest subagent cannot approve anything then, because it never has the mark. Keep the plugin's hook enabled.
- **A request waits for you, up to 30 minutes.** After that it counts as refused. Set `DELEGATE_APPROVAL_WAIT_SEC` to change the wait. A job that is waiting for your answer is not stopped by the lease.
- **Where nobody can answer, the answer is no.** That covers non-interactive runs and conversations in `dontAsk` mode.
- **One question at a time.** Each one costs a round trip through the subagent's model and a click from you. In `default` mode a busy delegate asks often, as Claude does.

### How each backend enforces a mode

- **Codex** is governed by its OS sandbox (`read-only`, `workspace-write` or `danger-full-access`), which decides what it does without asking. Each mode is one of the presets in Codex's own `/permissions` menu. Its approval requests go to you, except in `auto`, which sets the same three values as `codex --approve-for-me` (`workspace-write`, approval policy `on-request`, `approvalsReviewer: auto_review`), and in `dontAsk` and `bypassPermissions`, where it never asks. The sandbox is sent with every turn, so a mode means the same thing whatever your own Codex config says, and a continued conversation takes the mode of the current turn.
- **agy** is governed by its session mode, which decides what it does without asking. The session mode is agy's own counterpart of the Claude Code mode: `plan`, `default` (also for `dontAsk`), `accept-edits` or `auto`. Its requests go to you, with two exceptions: reading and searching inside the workspace is always allowed, and in `dontAsk` everything else is refused. `bypassPermissions` is different again: agy is started with `--dangerously-skip-permissions`, so it does not ask at all.

Before relying on a mode:

- **`plan` is not "writes nothing".** agy keeps its plan in its own data directory, and does not ask before writing it. The workspace is left alone.
- **`acceptEdits` is uneven.** Codex runs commands inside its sandbox without asking. agy asks before every command.
- **`auto` trusts the backend's own judgement.** Codex's reviewer can approve a step outside the workspace: in testing it approved a write and an `rm -rf` outside the workspace that the task had asked for. agy ran `rm` on a workspace file without asking.
- **`bypassPermissions` means what it says.** Neither backend is confined: Codex runs with no sandbox, and agy runs with its permission checks switched off. Both can touch anything your account can, with nobody approving each step. A delegate follows the conversation into this mode like any other, so a conversation in `bypassPermissions` delegates at `bypassPermissions`.
- **Codex has no network below `auto`**, unless you approve a request for it. Commands such as `npm install` ask first.
- **A refusal usually ends an agy turn.** When one of its requests is refused, agy tends to stop without a final message. Codex carries on and reports what it could not do.

Before a turn that can edit, make sure the delegate's files do not overlap with files Claude is editing.

### What the hook does

The plugin registers a `PreToolUse` hook on Bash ([hooks.json](plugins/delegate/hooks/hooks.json)). Claude Code hands every hook the conversation's current permission mode. The hook acts on two commands only, both of this plugin's own `companion.mjs`: the one that starts a task, and the one that approves a request. Every other Bash call passes through unchanged.

For the command that starts a task:

- **It passes the mode on.** It adds `--conversation-mode <mode>` to the command, and the script uses that mode when the task has no `--permission-mode` of its own. Because the hook runs on every turn, a follow-up turn picks up a mode you changed in between. A `--conversation-mode` that was already on the command is thrown away, so only the hook can say what mode the conversation is in.
- **It asks you before a step up.** The forwarding subagent reads another model's output, and that output can contain instructions. If the task names a mode that allows more than the conversation's, the hook has Claude Code ask you to approve the command. A mode that allows the same or less goes through without a question.
- **It refuses a command whose text the shell might run.** The task text travels in a heredoc. The hook refuses the command if a line of the text is exactly the heredoc's closing marker, if the marker is not quoted, or if the first line holds anything but flags and plain values. The refusal tells the subagent what to correct.
- **It refuses a command it cannot check.** The script has to be named by its full path, as the first thing in the command. A command that reaches it some other way, after a `cd` or by a relative path, is refused.

For the command that approves a request, it has Claude Code ask you, as described above, and marks the command so that the script can tell the approval came through the hook.

The hook never approves anything by itself: a command it lets through still goes to Claude Code's normal permission check.

## Layout

```text
plugins/delegate/
├── agents/            codex.md, agy.md: thin subagents that only forward
├── commands/          run, status, result, cancel, models, setup
├── hooks/             hooks.json: passes the conversation's permission mode to a task
├── skills/            delegating-tasks: when to delegate, how to brief, how to handle results
└── scripts/
    ├── companion.mjs  single entry point
    ├── permission-hook.mjs  the PreToolUse hook
    └── lib/
        ├── hook.mjs       what the hook decides about a command
        ├── abort.mjs      the grace period after a cancel
        ├── permission.mjs the permission modes, and which one a turn runs in
        ├── rpc.mjs        JSON-RPC client over a child process's stdio, shared by both backends
        ├── state.mjs      job records (one JSON file per job)
        ├── render.mjs     output formatting
        ├── text.mjs       clipping helpers for log entries
        └── backends/      codex.mjs, agy.mjs, index.mjs, and shared.mjs for what both do alike
```

Job records live in the system temp directory, under `delegate-plugin/`, in one directory per repository (all its worktrees share it). Set `DELEGATE_STATE_DIR` to keep them somewhere else. Claude Code's `CLAUDE_PLUGIN_DATA` directory is not used, because Claude Code gives it to hooks but not to shell commands, and the hook and the job have to look in the same place.

## Tests

```bash
node --test
```

The tests in `tests/` cover the hook's decisions and the command line, against job records written to a temporary directory. They start no backend, so they need neither CLI. The behaviour of the backends themselves was checked by hand, by running real tasks.

## Adding a backend

Create a file in `scripts/lib/backends/`, implement three methods, and register it in `index.mjs`:

- `check()` returns whether the CLI is installed, its version, and its login state.
- `listModels({ cwd })` returns `{ models, defaultModel, defaultEffort, note }`, where each model is `{ id, name, efforts }`.
- `run({ cwd, prompt, permissionMode, model, effort, resumeSessionId, signal, onEvent, askUser })` runs one turn in the given permission mode (the backend decides what each mode means for it) and returns `{ status, sessionId, model, text, actions, usage, error }`. When the agent asks for a permission that the mode leaves to the user, the backend awaits `askUser({ summary, detail })`, which resolves to `"allow"` or `"deny"`. When `signal` aborts, it must interrupt the running turn, and return within the grace period even if the agent never confirms (`afterAbort` in `lib/abort.mjs`).

`backends/shared.mjs` has the pieces that do not depend on the agent: how the plugin introduces itself, how to refuse a request it cannot answer, the shape of the token counts, and the wording of a user's reply to a refusal.

Then add `agents/<name>.md` so Claude can call it as a subagent.

## Known limitations

- Jobs are not scoped to a Claude session. Every session in the same repository sees the same list.
- Outside `bypassPermissions`, Codex cannot commit inside a worktree, because its sandbox does not include the main repository's `.git` directory.
- After its subagent is interrupted, a delegate keeps running for up to two minutes before the lease stops it. Use `/delegate:cancel` to stop it at once.
- Job records live in the system temp directory, which the system clears from time to time.
- The busy-conversation check is not atomic. Two resumes of the same conversation started within the same few milliseconds can both get through.
- In `dontAsk` mode, agy cannot run any command, so it investigates less well than Codex.
- When one of agy's requests is refused, it usually ends the turn without a final message. The result then shows the refused action and a note, and nothing else.
- Approving a request has only been tested by answering on the user's behalf from a test, and in a non-interactive session where the answer is always no. Clicking "allow" in Claude Code's own dialog is the one step that could not be exercised.
- The permission hook starts a Node process before every Bash call in the session, not only the delegate's. It exits at once for commands that are not a delegate task.
- If the hook does not run (the plugin's hooks are disabled, for instance), tasks without `--permission-mode` run in `default` mode, a task can name any mode without you being asked, and the forwarding subagent has no proper way to approve a request, so requests are refused.
- agy has no login-status command. `/delegate:setup` treats a successful `agy models` call as proof of login, which has not been tested against a logged-out agy.
- `codex app-server` is marked experimental upstream and its protocol may change between versions. This plugin was tested with codex-cli 0.170.0 and agy 1.5.12.
