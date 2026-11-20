# delegate

Hand a task from Claude Code to another vendor's coding agent and get the result back. Two backends are supported:

| Backend | CLI | Protocol |
|---|---|---|
| `codex` | OpenAI Codex | `codex app-server` (stdio JSON-RPC) |
| `agy` | Google Antigravity | `agy acp` (Agent Client Protocol) |

The plugin stores no credentials. It uses the login and configuration that each CLI already has on this machine.

## Install

### What you need

- Claude Code.
- Node.js 18.18 or later.
- At least one of the two agent CLIs, installed and signed in. You only need the ones you plan to use.

| Backend | Install | Sign in |
|---|---|---|
| Codex | `npm install -g @openai/codex` | `codex login` |
| Antigravity | Install the Antigravity CLI so that `agy` is on your `PATH` | Run `agy` once and sign in |

### Install the plugin

In Claude Code, run these two commands:

```text
/plugin marketplace add GammaExpansion/delegate-plugin
/plugin install delegate@delegate-marketplace
```

Or from a terminal:

```bash
claude plugin marketplace add GammaExpansion/delegate-plugin
```

```bash
claude plugin install delegate@delegate-marketplace
```

Then start a new Claude Code session, so that the plugin is loaded.

### Check that it works

```text
/delegate:setup
```

It lists each backend with its state. A backend you can use says `ready`:

```text
node: 22.19.0 (ok)
codex: ready · codex-cli 0.170.0
agy: ready · 1.5.12
```

For one that does not, the line under it says what to do. Then try a first task:

```text
Ask Codex what this repository does, in three sentences
```

### What it adds

- Two subagents, `delegate:codex` and `delegate:agy`, which Claude picks when you ask for Codex or Antigravity.
- Six commands: `/delegate:run`, `/delegate:status`, `/delegate:result`, `/delegate:cancel`, `/delegate:models` and `/delegate:setup`.
- One skill, which tells Claude when to delegate, how to brief a delegate, and how to choose what it may do.

It adds no hooks.

### Update or remove

```bash
claude plugin marketplace update delegate-marketplace
```

```bash
claude plugin update delegate@delegate-marketplace
```

```bash
claude plugin uninstall delegate@delegate-marketplace
```

### Work on the plugin itself

Clone the repository and load the plugin from your copy, without installing it:

```bash
claude --plugin-dir /path/to/delegate-plugin/plugins/delegate
```

Run the tests from the repository root with `node --test`. See [Tests](#tests).

## Usage

Ask in plain language and Claude picks the subagent:

```text
Ask Codex whether the token refresh logic in src/auth.ts has a race condition
```

Or use the commands:

```text
/delegate:run codex find out why tests/session.test.ts fails intermittently
/delegate:run agy --permission accept-edits fix the bug in math.js
/delegate:status
/delegate:result task-abc123
/delegate:cancel task-abc123
/delegate:models
```

| Option | Effect |
|---|---|
| `--permission <option>` | What the delegate may do this turn, as one of the backend's own options. Codex: `read-only`, `ask-for-approval`, `approve-for-me`, `full-access`. Antigravity: `plan`, `default`, `accept-edits`, `auto`, `skip-permissions`. See [Permission model](#permission-model). |
| `--sandbox enabled` or `disabled` | Overrides the sandbox that comes with the permission option. |
| `--worktree` | Only on `/delegate:run`. Runs the delegate in its own git worktree. Off by default. See [Worktrees](#worktrees). |
| `--brief-file <path>` | Takes the brief, or the long part of it, from a file. |
| `--model <id>` | Picks a model. Left out, the backend uses its own default. `/delegate:models` lists the ids each backend accepts. |
| `--effort <level>` | Picks a reasoning effort. |

## Conversations

A delegate behaves like any other Claude Code subagent:

- Each `delegate:codex` or `delegate:agy` subagent Claude starts is one conversation with that delegate.
- To follow up ("now apply the first fix you proposed"), Claude continues the same subagent. The delegate remembers the whole conversation.
- A new subagent is a new conversation. Several can run side by side.

Nobody has to keep track of ids. Under the hood the backend process exits after every turn, and the conversation lives in the backend's own session store. Every result prints that session's id, and the forwarding subagent passes the latest one back with `--resume` on the next turn.

Each turn can have its own options. A delegate that was refused something under `read-only` can be given `ask-for-approval` on the next turn of the same conversation, and it carries on from where it stopped. A turn that names no `--permission` keeps what the conversation's last turn had.

A conversation takes one turn at a time. Once its subagent is gone (the Claude Code session ended, for instance), the conversation can still be reopened by hand with `run --resume <session-id>`.

## Worktrees

By default a delegate works in the same directory as the conversation, like any subagent. Two delegates editing the same files, or a delegate and Claude, overwrite each other.

To give a delegate its own copy of the repository, ask for it ("have Codex do this in a worktree") or pass `--worktree` to `/delegate:run`. Claude then starts the subagent with Claude Code's own worktree isolation:

- Claude Code creates the worktree under `.claude/worktrees/` and a branch for it, and removes it again if the delegate changed nothing.
- The delegate works there for the whole conversation. Follow-ups to the same subagent stay in the same worktree.
- Every result names the worktree's path and branch. The edits stay there until that branch is merged. Merging is up to you.
- `/delegate:status`, `/delegate:result` and `/delegate:cancel` see the job from the main checkout as well, because jobs are grouped by repository, not by checkout.

What to know before using it:

- A worktree is a fresh checkout. Uncommitted changes in the main checkout are not in it. By default Claude Code starts it from the repository's default remote branch, so unpushed local commits are missing too. Set `worktree.baseRef` to `"head"` in Claude Code's settings to start from the current local commit. Files that git ignores are copied only if a `.worktreeinclude` file lists them.
- Codex cannot commit inside a worktree while it is sandboxed, which is every option except `full-access`. A worktree's index lives in the main repository's `.git` directory, which is outside the sandbox. Its edits are left uncommitted in the worktree. agy can commit when its option lets it run commands.
- It needs a git repository.

## How a task runs

Every task runs the same way:

1. The subagent saves the request to a file named `delegate-<random>.txt` in its scratchpad directory and calls `run --message-file <that file>`. `run` reads the options from the top of the request, removes the file, starts the delegate as a detached job, and waits for its first news.
2. While the job is not over, the output is three lines: `[delegate] still running`, one line on what the delegate did last, and the `wait` command to run next. The subagent runs that command, with that line as the description of the call, which is what you see while the delegate works.
3. When the job has ended, the delegate's answer is saved as `<job>.md` in the same scratchpad directory. The output is a few lines: the agent, the model, the outcome, the permission option and the job, the session id, anything that was declined, and the path of that file. The subagent returns those lines unchanged, and Claude reads the file.

The subagent's model decides nothing along the way, and nothing long passes through it. It does not keep an offset, judge whether the job has finished, summarise progress, or retype the answer. It writes the request to a file once, copies a command and a line of text, and at the end returns a few lines it was given.

The request file is removed once the job is on record. A request that is refused (a misspelt option, a conversation that is busy) leaves it in place, so the same command can be sent again. An answer file stays in the scratchpad until its job's record is pruned (the 50 jobs of a repository that finished last are kept) or Claude Code clears the scratchpad. If the file is gone when the answer is asked for again, it is written again from the job's record.

The full record of a job, with every action and the token counts, is one command away: `/delegate:result <job-id>`.

The delegate is shown as `Codex Agent` or `Gemini Agent`, with the model it is running on once that is known, as in `Codex Agent (gpt-6.2-astra xHigh)`. Codex's reasoning effort is shown beside its model. An agy model id already ends in its thinking level. The name leads each progress line and the first line of the result.

Codex can start agents of its own. What they do appears in the progress under their names (`subagent explorer: ...`), and is not part of the answer.

`wait` returns when there is something to tell, not on a timer. Once the delegate logs new activity, `wait` keeps collecting for a short settle window (6 seconds in a job's first minute, 15 up to five minutes, 60 after that) and then returns. If the delegate is silent it returns after 90 seconds. Progress therefore arrives in steps, not token by token.

To watch a job in more detail, run `status <job-id>` in a terminal or read the job log.

To keep working while a delegate runs, have Claude run the subagent in the background. Claude Code reports back when it finishes.

## Design decisions

### The script decides, the subagent copies

The forwarding subagent is a model, and every decision left to a model is one it can get wrong. An earlier version left it many: move flags out of the request and onto the command line, carry a byte offset from call to call, tell a finished job from a running one, cut the result out from under a marker line, summarise the log into a progress note, and take a permission request to the user and back.

- **What changed.** All of that is now in the script. The options stay in the request, where the script reads them. The offset is a file beside the job. The first line of the output says whether the job is over. The progress line and the next command are written out ready to use.
- **What is left to the model.** Two things that Claude Code gives a script no way to do: issuing the next tool call, whose description is the only place progress can be shown, and remembering the session id between turns, because a script run through Bash is not told which subagent called it.
- **What it costs.** The progress line is made mechanically from the last thing the delegate did, so it reads plainer than a model's summary.
- **What it saves.** The subagent reads neither the delegate's log nor its answer. Its context stops growing with the job, and the delegate's output has no way into its instructions.

### Long text travels in files

Neither the request nor the answer is put through a shell command or retyped by the subagent's model. Both were, in an earlier version, and both broke under long content:

- **The request went in a heredoc.** Claude Code checks every Bash command before running it, and that check reads the heredoc's body. A brief that quoted ordinary code was refused as a suspicious command, so the delegate never got it. A heredoc also ends at the first line equal to its closing marker, and the marker a model "makes up at random" turned out to be the same string nearly every time.
- **The answer was retyped.** The subagent's model read the answer and wrote it out again for Claude. In a run of nine long answers, two came back with a word changed (a wrong path in one), and one subagent then added a correction of its own to the next answer. Claude Code also shows a command's output only up to about 30 KB: a 43 KB answer reached the subagent as its first 2 KB.

- **What replaced them.** The subagent writes the request to a file with its Write tool, which no shell sees. The script writes the answer to a file, and Claude reads it with its own Read tool. What the subagent handles is a path each way.
- **Why the scratchpad.** Claude Code gives each session a scratchpad directory that its agents read and write without asking. A file in the system's temp directory would need your permission to be read.
- **What it costs.** One more call by the subagent for each message, and one read by Claude for each answer, even a one-line one.
- **What is still retyped.** The request, once, by the subagent, into the file. For a long brief or one with code, Claude can write the brief to a file itself and name it with `--brief-file`, and then nothing is.

### One way to run a task

There is no background mode. One existed in an earlier version and was removed.

- **Why a loop at all.** A Bash call from Claude Code lasts ten minutes at most, and nothing a command does is visible until it returns. A task can take far longer, so the job runs detached and is waited on in short calls.
- **Why one path is enough.** Waiting in short calls has no time limit and shows progress. Not blocking the main conversation is something Claude Code already does for any subagent, so the plugin does not need its own mechanism.
- **What it costs.** Each `wait` call is one call to the subagent's model. It is a small one: three lines in, one command out.

### A conversation is a subagent

Continuing a delegate conversation means continuing its subagent, exactly as with a native subagent. An earlier version had the main agent keep job ids and pass `--resume <id>` to a fresh subagent each turn.

- **Why.** The point of the plugin is that Codex and Antigravity can be used the way subagents are. Claude's habit is to continue a subagent by sending it a message. With a stateless forwarder that habit silently opened a new conversation, and the delegate had forgotten what came before, including any question it had just asked.
- **How.** Every result names the backend session. The forwarding subagent is told to resume the session of the most recent result it has.
- **What it gives up.** A conversation is tied to its subagent's lifetime. Reopening it later is possible but manual.

### Worktrees belong to Claude Code, and are off by default

The plugin creates no worktrees of its own. Isolation is the option Claude Code already has for any subagent, switched on per call.

- **Why not manage them in the script.** Claude Code already creates the worktree, keeps a continued subagent in it, reports its path and branch, and cleans it up. A second implementation would have to redo all of that, and would give the main agent one more flag to learn. It also fits the rest of the design: a delegate is a subagent, so it is isolated the way a subagent is.
- **Why off by default.** A worktree does not contain uncommitted work, and much of what a delegate is asked to do is to look at exactly that: review this change, diagnose this failing test. Isolation is for the other case, where a delegate edits while something else edits the same repository.
- **What the plugin had to change.** Job records used to be grouped by checkout, which hid a worktree's jobs from the main checkout. They are now grouped by repository.
- **What it gives up.** Isolation only exists inside Claude Code. A task started by hand runs wherever it was started.

### Permissions are the backend's own, and nobody approves mid-turn

A turn runs under one of the backend's own permission options, named on the request. What that option does not allow is declined and reported. To allow more, the same conversation is continued with another option.

An earlier version did two things differently, and both were removed:

- **It translated Claude Code's permission modes.** A hook read the conversation's mode before every Bash call and mapped it onto each backend's settings. The three vendors cut permissions differently, so the mapping was a table of approximations that had to be explained row by row, and the hook needed a parser for the subagent's shell commands that had to agree exactly with the script's own. Two ways were found to make them disagree and step past the check.
- **It put a delegate's requests to the user.** The job held the request open, the subagent ran a command, and the hook turned that command into Claude Code's permission dialog. It took a third of the subagent's instructions, a secret file, a waiting queue and a 30-minute timeout, and its main path, a click on "allow", could never be exercised in a test.

What replaced them:

- **The choice is made in words.** The main agent, or you, writes `--permission` on the request. The skill tells the main agent to pass the option that matches the permission mode its own conversation is in, which it knows, so a delegate gets what the conversation has.
- **A refusal is information, not a dead end.** The result lists what was declined. The main agent can raise the option and continue the same conversation, or ask you first.
- **What it gives up.** Nothing in code ties a delegate to the conversation's permission mode. A conversation in plan mode can still start a delegate that edits files, if the main agent writes an option that allows it. And a delegate that needs one approval to finish cannot get it mid-turn: it takes another turn.

### `wait` is driven by activity, not by a clock

The subagent's model can only act when a tool call returns, so the delegate cannot push a message to it. The nearest thing is a call that blocks until there is news. `wait` does that: the script watches the job log (cheap, no model involved) and returns only when the delegate has done something, when it has ended, or after 90 seconds of silence. A delegate that thinks quietly for five minutes costs three or four calls. A busy one costs at most one call per settle window.

### A job needs someone waiting on it

Every `wait` call marks the job as watched. A job that nothing has waited on for 120 seconds interrupts its delegate and ends as cancelled.

- **Why.** The delegate runs in its own process, so interrupting the subagent, or closing Claude Code, would otherwise leave Codex or agy working, and possibly editing files, with nobody reading the result.
- **Why a lease and not a signal.** Nothing tells the script that the subagent was interrupted. The absence of `wait` calls is the only evidence there is.
- **The trade-off.** A delegate keeps running for up to two minutes after its subagent stops. Set `DELEGATE_LEASE_SEC` to change the window, or to `0` to turn it off. The conversation is kept either way and can be continued with `--resume`.
- **Sleep does not count.** While the machine is asleep whatever waits on the job is frozen too. A job that notices it has been suspended starts a fresh window instead of stopping at once.

## Permission model

A delegate turn runs under one permission option, and the option is the backend's own. It is written on the first line of the request:

```text
--permission ask-for-approval
Fix the off-by-one in src/paging.ts and run the tests.
```

Nothing is translated from Claude Code's permission modes, and nothing is inherited from the conversation. What a delegate may do is what the request says.

**Codex** (`codex app-server`)

| `--permission` | Codex's name | Sandbox | When it asks |
|---|---|---|---|
| `read-only` (when left out) | Read Only | Cannot write, no network. Commands that only read still run. | Before anything more. |
| `ask-for-approval` | Ask for approval | Can write to the workspace and temp directories. No network. | Before stepping outside the sandbox. |
| `approve-for-me` | Approve for me | The same. | The same, but its own automatic reviewer answers. |
| `full-access` | Full Access | None. Network included. | Never. |

`--sandbox disabled` takes the sandbox away from an option. `--sandbox enabled` with `full-access` keeps the workspace sandbox while Codex asks nothing, so a step the sandbox stops simply fails.

**Antigravity** (`agy acp`)

| `--permission` | What agy does without asking | What it asks about |
|---|---|---|
| `default` (when left out) | Reads and searches. | Every edit and every command. |
| `plan` | Researches, and writes a plan into its own data directory. | Edits and commands. |
| `accept-edits` | Edits files in the workspace. | Every command, and anything outside the workspace. |
| `auto` | Edits files and runs commands. | What it judges risky. |
| `skip-permissions` | Everything. It is started with `--dangerously-skip-permissions`. | Nothing. |

`--sandbox enabled` starts agy with its own `--sandbox` flag, which restricts what its terminal can do.

### Nobody approves a request mid-turn

When a delegate asks for something its option does not allow, the answer is no. There is no dialog and nobody is asked.

- **Codex** records the step as declined, carries on, and says in its answer what it could not do.
- **agy** tends to stop at a declined request without a word. When that happens the job tells it that nobody can approve and asks it to finish what it can, up to twice in one turn.
- One kind of request is allowed: agy reading or searching inside the workspace.
- With `skip-permissions` agy is not meant to ask at all. If it asks anyway, the answer is yes, once.

The result lists what was declined, and says which option the turn ran with:

```text
[delegate] Codex Agent (gpt-6.2-astra xHigh) · completed · 17.1s · read-only · task-abc123
session: 01a1f822-b94d-7cd3-b925-ce82e6ebc1fc
declined (1):
- [command] /bin/zsh -lc 'printf %s world > b.txt' (declined)
note: nobody can approve a request while a delegate runs, so these were declined. ...

I couldn't create b.txt because write permission was denied.
```

### Which option a delegate gets

The plugin does not read the conversation's permission mode. Claude knows which mode its conversation is in, and the skill tells it to pass the option that matches:

| The conversation's mode | Codex | Antigravity |
|---|---|---|
| plan | `read-only` | `plan` |
| default (Claude asks before each edit) | `read-only` | `default` |
| accept edits | `ask-for-approval` | `accept-edits` |
| auto | `approve-for-me` | `auto` |
| bypass permissions | `full-access` | `skip-permissions` |

- An option you name yourself comes first.
- If Claude cannot tell which mode it is in, it gives the least the task needs.

This is guidance to a model, not a check in code. See [Design decisions](#permissions-are-the-backends-own-and-nobody-approves-mid-turn).

### Raising the option

To let a delegate do what was declined, the same conversation is continued with another `--permission`. The delegate still has the whole conversation, so "try again" is enough. Each turn names its own option. A turn that names none keeps what the last turn had.

A delegate starts with what the conversation has, so Claude does not raise the option on its own. It tells you what was declined and which option would allow it, and continues once you agree or once you have changed the conversation's mode.

### Before relying on an option

- **`plan` is not "writes nothing".** agy keeps its plan in its own data directory, and does not ask before writing it. The workspace is left alone.
- **agy runs no commands below `auto`.** In `default`, `plan` and `accept-edits` it asks before each one, and nobody answers. So it cannot run `git diff` or a test there. For a review of uncommitted work, the diff has to be in the brief.
- **`approve-for-me` and `auto` trust the backend's own judgement.** Codex's reviewer can approve a step outside the workspace: in testing it approved a write and an `rm -rf` outside the workspace that the task had asked for. agy ran `rm` on a workspace file without asking.
- **`full-access` and `skip-permissions` mean what they say.** Neither backend is confined. Both can touch anything your account can, with nobody approving each step.
- **Codex has no network inside its sandbox.** Commands such as `npm install` are declined below `full-access`, unless its reviewer lets them through under `approve-for-me`.
- **The sandbox is sent with every Codex turn**, so an option means the same thing whatever your own Codex config says, and a continued conversation takes the option of the current turn.

Before a turn that can edit, make sure the delegate's files do not overlap with files Claude is editing.

## Layout

```text
plugins/delegate/
├── agents/            codex.md, agy.md: thin subagents that only pass requests on
├── commands/          run, status, result, cancel, models, setup
├── skills/            delegating-tasks: when to delegate, how to brief, what to permit, how to handle results
└── scripts/
    ├── companion.mjs  single entry point
    └── lib/
        ├── args.mjs       command-line options, and the options at the top of a request
        ├── abort.mjs      the grace period after a cancel
        ├── pacing.mjs     how often `wait` comes back with news
        ├── progress.mjs   the one-line account of what a delegate did last
        ├── rpc.mjs        JSON-RPC client over a child process's stdio, shared by both backends
        ├── state.mjs      job records (one JSON file per job)
        ├── render.mjs     output formatting
        ├── text.mjs       clipping helpers for log entries
        └── backends/      codex.mjs, agy.mjs, index.mjs, and shared.mjs for what both do alike
```

Job records live in the system temp directory, under `delegate-plugin/`, in one directory per repository (all its worktrees share it). Set `DELEGATE_STATE_DIR` to keep them somewhere else.

To see what a backend really sent, set `DELEGATE_TRACE=1` where the job is started. The job then writes every JSON-RPC message it sends and receives, with the time, to `<job id>.trace.jsonl` beside its record. The file holds the prompt and everything the delegate read or wrote, in full, and is removed with the record.

## Tests

```bash
node --test
```

The tests in `tests/` cover the command line, against job records written to a temporary directory, and both backends, against stand-ins for `codex app-server` and `agy acp`. They need neither CLI. The behaviour of the real backends was checked by hand, by running real tasks.

## Adding a backend

Create a file in `scripts/lib/backends/`, give it the following, and register it in `index.mjs`:

- `permissions`, an object keyed by the names `--permission` takes for this backend, and `defaultPermission`, the one used when none is given. Use the agent's own names for them.
- `settingsFor({ permission, sandbox })` checks a choice and returns `{ permission, sandbox, settings }` with the names in their proper form. It throws on an option the backend does not have.
- `check()` returns whether the CLI is installed, its version, and its login state.
- `listModels({ cwd })` returns `{ models, defaultModel, defaultEffort, note }`, where each model is `{ id, name, efforts }`.
- `run({ cwd, prompt, permission, sandbox, model, effort, resumeSessionId, signal, traceFile, onEvent })` runs one turn and returns `{ status, sessionId, model, text, actions, usage, error }`, and may add `notes`, lines the reader of a result should see besides, such as a command left running. When the agent asks for approval, the backend declines and makes sure the declined step is among `actions`, with `status: "declined"` or `permission: "denied"`. When `signal` aborts, it must interrupt the running turn, and return within the grace period even if the agent never confirms (`afterAbort` in `lib/abort.mjs`).

`backends/shared.mjs` has the pieces that do not depend on the agent: how the plugin introduces itself, how to refuse a request it cannot answer, the shape of the token counts, and the checks on `--permission` and `--sandbox`.

Then add `agents/<name>.md` so Claude can call it as a subagent.

## Known limitations

- Jobs are not scoped to a Claude session. Every session in the same repository sees the same list.
- Nothing in code holds a delegate to the conversation's permission mode. A delegate gets the option written on its request, and keeping that within what the conversation allows is left to Claude's judgement and yours.
- A delegate cannot be approved mid-turn. What needs approval is declined, and letting it through takes another turn with a higher option.
- Messages and answers are exchanged as files in the session's scratchpad directory, which exists only inside Claude Code. A task started by hand prints its answer.
- An answer reaches Claude only when Claude reads its file. A result that is passed on unread says nothing but where the answer is.
- agy runs a slow command in the background and ends its turn before the command has finished. The job waits for it to carry on. It stops waiting when the command shows no sign of life for 30 minutes (`DELEGATE_AGY_BACKGROUND_WAIT_SEC`) or is still running two hours after the turn ended (`DELEGATE_AGY_BACKGROUND_MAX_SEC`). What agy had said by then is the answer, and the result says in a `note:` line that the job stopped waiting. If agy had said nothing, the job fails.
- A command that agy starts to keep running, such as a server or an emulator, is not waited for: the job ends with the turn and the result names the command in a `note:` line. This goes by the `IsDaemon` mark agy's terminal tool puts on such a call. A server that agy starts without the mark is waited for like any slow command.
- The command stays running after the job. Nothing in the plugin stops it.
- agy answers a resumed session's `session/load` while it is still replaying a long history, and marks neither the replayed updates nor their end. A prompt sent during the replay is dropped: the turn comes back at once as finished, with the model never called. So the job takes the history as over once no update has come for one second, and only then sends the prompt. A turn that still comes back that way is reported as failed. This adds about a second to every resumed agy turn.
- Below `full-access`, Codex cannot commit inside a worktree, because its sandbox does not include the main repository's `.git` directory.
- After its subagent is interrupted, a delegate keeps running for up to two minutes before the lease stops it. Use `/delegate:cancel` to stop it at once.
- Job records live in the system temp directory, which the system clears from time to time.
- The busy-conversation check is not atomic. Two resumes of the same conversation started within the same few milliseconds can both get through.
- In `default`, agy cannot run any command, so it investigates less well than Codex does in `read-only`.
- agy's `--sandbox` flag is passed on as it is. What exactly it restricts was not tested.
- agy has no login-status command. `/delegate:setup` treats a successful `agy models` call as proof of login, which has not been tested against a logged-out agy.
- If Codex gives its final answer and then never reports the turn as finished, the job takes the turn as finished 1.5 seconds later, provided none of Codex's own agents is still at work.
- `codex app-server` is marked experimental upstream and its protocol may change between versions. This plugin was tested with codex-cli 0.170.0 and agy 1.5.12.

## License

MIT. See [LICENSE](LICENSE).
