# delegate

Hand a task from Claude Code to another vendor's coding agent and get the result back. Two backends are supported:

| Backend | CLI | Protocol |
|---|---|---|
| `codex` | OpenAI Codex | `codex app-server` (stdio JSON-RPC) |
| `agy` | Google Antigravity | `agy acp` (Agent Client Protocol) |

The plugin stores no credentials. It uses the login and configuration that each CLI already has on this machine.

## Install

### What you need

- Claude Code with mods, its function-hooks plugins. The plugin's tools are a mod, so a Claude Code that runs no mods, or an organization that does not allow them, gets no tools. Built and tested on Claude Code 2.1.330.
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

- Three tools, which Claude calls itself: `mcp__delegate__codex` and `mcp__delegate__agy` run a turn of a conversation with Codex or Antigravity, and `mcp__delegate__wait` collects the result of one started in the background. They come from a mod, `hooks/register.tsx`, which Claude Code runs in an environment of its own.
- Six commands: `/delegate:run`, `/delegate:status`, `/delegate:result`, `/delegate:cancel`, `/delegate:models` and `/delegate:setup`.
- One skill, which tells Claude when to delegate, how to brief a delegate, and how to choose what it may do.

The mod hooks nothing of Claude Code's own. It registers the three tools, draws a line under their rows while they run, and follows jobs started in the background.

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

An interactive session reloads the mod when a file of it is saved. See [Tests](#tests) for the two test suites.

## Usage

Ask in plain language and Claude calls the tool:

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

| Option on `/delegate:run` | Tool field | Effect |
|---|---|---|
| `--permission <option>` | `permission` | What the delegate may do this turn, as one of the backend's own options. Codex: `read-only`, `ask-for-approval`, `approve-for-me`, `full-access`. Antigravity: `plan`, `default`, `accept-edits`, `auto`, `skip-permissions`. See [Permission model](#permission-model). |
| `--sandbox enabled` or `disabled` | `sandbox` | Overrides the sandbox that comes with the permission option. |
| `--worktree` | `worktree` | Runs a new conversation in its own git worktree. Off by default. See [Worktrees](#worktrees). |
| `--background` | `background` | Returns as soon as the delegate has started. See [Background](#background). |
| `--model <id>` | `model` | Picks a model. Left out, the backend uses its own default. `/delegate:models` lists the ids each backend accepts. |
| `--effort <level>` | `effort` | Picks a reasoning effort. |

## Conversations

Each call of `mcp__delegate__codex` or `mcp__delegate__agy` is one turn of a conversation with that delegate:

- A call without `session` starts a new conversation.
- To follow up ("now apply the first fix you proposed"), Claude passes the `session` that the conversation's latest result names. The delegate remembers the whole conversation.
- Several conversations can run at once. See [Background](#background).

Under the hood the backend process exits after every turn, and the conversation lives in the backend's own session store. Every result prints that session's id.

Each turn can have its own options. A delegate that was refused something under `read-only` can be given `ask-for-approval` on the next turn of the same conversation, and it carries on from where it stopped. A turn that names no `permission` keeps what the conversation's last turn had.

A conversation takes one turn at a time. It outlives the Claude Code session it started in: a later session, or `run --resume <session-id>` in a terminal, can continue it.

## Background

A call with `background: true` returns as soon as the delegate has started, with the job's id, and Claude carries on with other work:

- Once the job ends, the mod hands its result to Claude in a message of its own, from the plugin. If Claude is in the middle of a turn, the message waits for that turn to end.
- To collect a result sooner, Claude calls `mcp__delegate__wait` with the job id. A result collected that way is not handed over again.
- To run several delegates side by side, Claude starts each one with `background: true` and then waits for each. The jobs run meanwhile, so waiting for them in turn takes no longer than the longest.

A background job is followed only while the Claude Code session that started it is open. Once nothing follows it, its lease stops it within two minutes. See [A job needs someone waiting on it](#a-job-needs-someone-waiting-on-it).

## Worktrees

By default a delegate works in the same directory as the conversation. Two delegates editing the same files, or a delegate and Claude, overwrite each other.

To give a delegate its own copy of the repository, ask for it ("have Codex do this in a worktree") or pass `--worktree` to `/delegate:run`. The tool then asks Claude Code for a worktree, the same way Claude Code makes one for a subagent it isolates:

- Claude Code creates the worktree under `.claude/worktrees/`, with a branch for it. `worktree.baseRef` in Claude Code's settings decides what it starts from.
- The delegate works there for the whole conversation. Later turns of the same conversation stay in the same worktree, wherever they are started from.
- Every result names the worktree's path and branch. The edits stay there until that branch is merged. Merging, and removing the worktree, are up to you.
- `/delegate:status`, `/delegate:result` and `/delegate:cancel` see the job from the main checkout as well, because jobs are grouped by repository, not by checkout.

What to know before using it:

- A worktree is a fresh checkout. Uncommitted changes in the main checkout are not in it. By default it starts from the repository's default remote branch, so unpushed local commits are missing too. Set `worktree.baseRef` to `"head"` to start from the current local commit. Files that git ignores are copied only if a `.worktreeinclude` file lists them.
- Codex cannot commit inside a worktree while it is sandboxed, which is every option except `full-access`. A worktree's index lives in the main repository's `.git` directory, which is outside the sandbox. Its edits are left uncommitted in the worktree. agy can commit when its option lets it run commands.
- It needs a git repository.

## How a task runs

Every task runs the same way:

1. Claude calls the tool. The mod runs `companion.mjs run --json --verbatim` with the task on standard input and the options on the command line. `run` starts the delegate as a detached job and waits for its first news.
2. While the job is not over, the news is one JSON object that says what the delegate did last. The mod draws that under the call's row and runs `wait --json` for the next news.
3. When the job has ended, the news holds the result: the agent, the model, the outcome, the permission option and the job, the session id, anything that was declined, and the delegate's answer. That is the tool's result.

No model takes part along the way. Claude makes one tool call and reads one result, and the mod's code does the waiting.

The full record of a job, with every action and the token counts, is one command away: `/delegate:result <job-id>`.

The delegate is shown as `Codex Agent` or `Gemini Agent`, with the model it is running on once that is known, as in `Codex Agent (gpt-6.2-astra xHigh)`. Codex's reasoning effort is shown beside its model. An agy model id already ends in its thinking level. The name leads the progress line and the first line of the result.

Codex can start agents of its own. What they do appears in the progress under their names (`subagent explorer: ...`), and is not part of the answer.

`wait` returns when there is something to tell, not on a timer. The mod has it return a second after the delegate logs new activity, or after 20 seconds of silence. Progress therefore arrives in steps, not token by token.

Pressing Esc while a call runs ends the call and cancels its job. A background job is not cancelled by an Esc during a `wait`: the wait ends, and the job goes on.

To watch a job in more detail, run `status <job-id>` in a terminal or read the job log.

## Design decisions

### No model between Claude and the delegate

Earlier versions ran every task through a forwarding subagent, a Sonnet model whose only job was to pass the request on and the answer back. It was there because a subagent was the only thing in Claude Code that could both wait a long time and show what it was waiting for: it waited in short Bash calls, and each call's description was the progress line.

- **What it cost.** A model call for every step of the wait, a model's tokens for every task, however small, and a set of instructions that had to keep the model from doing anything else: save the request to a file, copy a command and its description exactly, return a few lines unread.
- **What it could get wrong.** Every decision left to it was one it could get wrong. Most were moved into the script over time, until what was left was copying.
- **What replaced it.** A mod, Claude Code's own function hooks, can register a tool whose body is code: it runs as long as it needs to, it can draw on the call's row while it runs, and its result goes straight to Claude. The forwarding subagent's job became that tool's body, and the subagent was removed.
- **What it costs instead.** The plugin needs a Claude Code that runs mods, and the mods API is marked early access. Where mods cannot load, the plugin has no way to run a task.

### Long text never passes through a shell or a model

The request and the answer each travelled through a shell command or a model in an earlier version, and both broke under long content:

- **The request went in a heredoc.** Claude Code checks every Bash command before running it, and that check reads the heredoc's body. A brief that quoted ordinary code was refused as a suspicious command, so the delegate never got it.
- **The answer was retyped.** The forwarding subagent's model read the answer and wrote it out again for Claude. In a run of nine long answers, two came back with a word changed.

Now the task is a field of the tool call. The mod writes it to the script's standard input, whole, and `--verbatim` keeps the script from reading options out of it. The answer is the tool's result, as the script printed it. No file is exchanged, so the scratchpad and the files a forwarding subagent had to write are gone.

### Background is the plugin's own

A subagent could be run in the background by Claude Code. A tool call cannot, so the plugin has its own background mode.

- **How.** `background: true` returns once the job has started. A timer in the mod looks at each such job every five seconds and, once it has ended, hands its result to Claude with a message of the plugin's. `mcp__delegate__wait` collects a result sooner, and a result is handed over once, whichever comes first.
- **Why a message and not a note.** A note added to the conversation reaches Claude only on its next request, so a result that came in while Claude was idle would wait for you to type something. A message starts a turn of its own once Claude is idle.

### A conversation is its session id

Every result names the backend session, and Claude passes it back as `session` to continue the conversation. With a subagent, continuing the subagent continued the conversation, and Claude did not have to keep the id.

- **Why it is fine now.** Earlier, a stateless forwarder made Claude's habit of continuing a subagent open a new conversation by accident. A tool has no such habit to break. Its description says how to continue, and every result names the session.
- **What it gives.** A conversation is no longer tied to a subagent's life. It can be continued from a later session, or by hand.

### Worktrees come from Claude Code, and are off by default

The plugin does not make worktrees itself. It asks Claude Code for one, the same way Claude Code makes one for a subagent it isolates, and the script keeps a conversation in it.

- **Why not make them in the script.** Claude Code already knows how: where they go, what they start from (`worktree.baseRef`), which files to copy into them. A second way would disagree with it sooner or later.
- **Why off by default.** A worktree does not contain uncommitted work, and much of what a delegate is asked to do is to look at exactly that: review this change, diagnose this failing test. Isolation is for the other case, where a delegate edits while something else edits the same repository.
- **What it gives up.** A subagent's worktree was removed when the subagent ended without changes. A conversation has no such end, so its worktree stays until you remove it.

### Permissions are the backend's own, and nobody approves mid-turn

A turn runs under one of the backend's own permission options, named on the call. What that option does not allow is declined and reported. To allow more, the same conversation is continued with another option.

An earlier version did two things differently, and both were removed:

- **It translated Claude Code's permission modes.** A hook read the conversation's mode before every Bash call and mapped it onto each backend's settings. The three vendors cut permissions differently, so the mapping was a table of approximations that had to be explained row by row, and the hook needed a parser for the subagent's shell commands that had to agree exactly with the script's own. Two ways were found to make them disagree and step past the check.
- **It put a delegate's requests to the user.** The job held the request open, the subagent ran a command, and the hook turned that command into Claude Code's permission dialog. It took a third of the subagent's instructions, a secret file, a waiting queue and a 30-minute timeout, and its main path, a click on "allow", could never be exercised in a test.

What replaced them:

- **The choice is made in words.** Claude, or you, names the `permission`. The skill tells Claude to pass the option that matches the permission mode its own conversation is in, which it knows, so a delegate gets what the conversation has.
- **A refusal is information, not a dead end.** The result lists what was declined. Claude can raise the option and continue the same conversation, or ask you first.
- **What it gives up.** Nothing in code ties a delegate to the conversation's permission mode. A conversation in plan mode can still start a delegate that edits files, if Claude names an option that allows it. And a delegate that needs one approval to finish cannot get it mid-turn: it takes another turn.

### `wait` is driven by activity, not by a clock

The delegate cannot push news to its caller. The nearest thing is a call that blocks until there is news. `wait` does that: the script watches the job log and returns when the delegate has done something, when it has ended, or after a stretch of silence. Its caller is now the mod's code, not a model, so news can come as often as the delegate makes it: a second after each step.

### A job needs someone waiting on it

Every `wait` call marks the job as watched. A job that nothing has waited on for 120 seconds interrupts its delegate and ends as cancelled.

- **Why.** The delegate runs in its own process, so closing Claude Code would otherwise leave Codex or agy working, and possibly editing files, with nobody reading the result.
- **Why a lease and not a signal.** A Claude Code that quits, or a machine that loses power, sends the script nothing. The absence of `wait` calls is the only evidence there is. An Esc on a running call does cancel its job at once.
- **The trade-off.** A delegate whose session went away keeps running for up to two minutes. Set `DELEGATE_LEASE_SEC` to change the window, or to `0` to turn it off. The conversation is kept either way and can be continued.
- **Sleep does not count.** While the machine is asleep whatever waits on the job is frozen too. A job that notices it has been suspended starts a fresh window instead of stopping at once.

## Permission model

A delegate turn runs under one permission option, and the option is the backend's own. It is the call's `permission` field, or `--permission` on `/delegate:run`:

```text
/delegate:run codex --permission ask-for-approval fix the off-by-one in src/paging.ts and run the tests
```

Nothing is translated from Claude Code's permission modes, and nothing is inherited from the conversation. What a delegate may do is what the call says.

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

To let a delegate do what was declined, the same conversation is continued with another `permission`. The delegate still has the whole conversation, so "try again" is enough. Each turn names its own option. A turn that names none keeps what the last turn had.

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
├── hooks/             the mod: register.tsx (the three tools) and its tests, named in hooks.json
├── types/             the values the mod keeps in Claude Code's state, as a type contract
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

```bash
claude plugin test plugins/delegate
```

```bash
claude plugin validate plugins/delegate
```

- `node --test` runs the tests in `tests/`. They cover the command line, against job records written to a temporary directory, and both backends, against stand-ins for `codex app-server` and `agy acp`. They need neither CLI.
- `claude plugin test` runs the mod's tests in `hooks/`, against Claude Code's own engine with a stand-in for the script: the tools, what they pass to the script, the background follower, and the line drawn under a call's row on every surface.
- `claude plugin validate` reads the manifest and the mod the way Claude Code will, and reports what it would refuse.

The behaviour of the real backends was checked by hand, by running real tasks.

## Adding a backend

Create a file in `scripts/lib/backends/`, give it the following, and register it in `index.mjs`:

- `permissions`, an object keyed by the names `--permission` takes for this backend, and `defaultPermission`, the one used when none is given. Use the agent's own names for them.
- `settingsFor({ permission, sandbox })` checks a choice and returns `{ permission, sandbox, settings }` with the names in their proper form. It throws on an option the backend does not have.
- `check()` returns whether the CLI is installed, its version, and its login state.
- `listModels({ cwd })` returns `{ models, defaultModel, defaultEffort, note }`, where each model is `{ id, name, efforts }`.
- `run({ cwd, prompt, permission, sandbox, model, effort, resumeSessionId, signal, traceFile, onEvent })` runs one turn and returns `{ status, sessionId, model, text, actions, usage, error }`, and may add `notes`, lines the reader of a result should see besides, such as a command left running. When the agent asks for approval, the backend declines and makes sure the declined step is among `actions`, with `status: "declined"` or `permission: "denied"`. When `signal` aborts, it must interrupt the running turn, and return within the grace period even if the agent never confirms (`afterAbort` in `lib/abort.mjs`).

`backends/shared.mjs` has the pieces that do not depend on the agent: how the plugin introduces itself, how to refuse a request it cannot answer, the shape of the token counts, and the checks on `--permission` and `--sandbox`.

Then give it a tool in `hooks/register.tsx`: its `runSpec` entry, with the backend's permission options in `PERMISSIONS`, and a `tool.run` hook that calls `runTool` with the backend's name.

## Known limitations

- Jobs are not scoped to a Claude session. Every session in the same repository sees the same list.
- Nothing in code holds a delegate to the conversation's permission mode. A delegate gets the option written on its request, and keeping that within what the conversation allows is left to Claude's judgement and yours.
- A delegate cannot be approved mid-turn. What needs approval is declined, and letting it through takes another turn with a higher option.
- The plugin runs a task only through its mod. A Claude Code that runs no mods, or an organization policy that keeps them from loading, leaves Claude with no delegate tools. The mods API is marked early access and may change between Claude Code releases.
- Whether Claude Code runs two delegate calls of one message side by side was not checked. Starting them with `background: true` runs them side by side either way.
- A background job's result is handed to Claude in a message from the plugin, which starts a turn of its own once Claude is idle. A background job is followed only while its Claude Code session is open.
- A very long answer is handed over whole as the tool's result. How Claude Code shows or shortens a tool result of that size was not checked.
- A worktree made for a conversation is not removed when the conversation is done, even if the delegate changed nothing.
- agy runs a slow command in the background and ends its turn before the command has finished. The job waits for it to carry on. It stops waiting when the command shows no sign of life for 30 minutes (`DELEGATE_AGY_BACKGROUND_WAIT_SEC`) or is still running two hours after the turn ended (`DELEGATE_AGY_BACKGROUND_MAX_SEC`). What agy had said by then is the answer, and the result says in a `note:` line that the job stopped waiting. If agy had said nothing, the job fails.
- A command that agy starts to keep running, such as a server or an emulator, is not waited for: the job ends with the turn and the result names the command in a `note:` line. This goes by the `IsDaemon` mark agy's terminal tool puts on such a call. A server that agy starts without the mark is waited for like any slow command.
- The command stays running after the job. Nothing in the plugin stops it.
- agy answers a resumed session's `session/load` while it is still replaying a long history, and marks neither the replayed updates nor their end. A prompt sent during the replay is dropped: the turn comes back at once as finished, with the model never called. So the job takes the history as over once no update has come for one second, and only then sends the prompt. A turn that still comes back that way is reported as failed. This adds about a second to every resumed agy turn.
- Below `full-access`, Codex cannot commit inside a worktree, because its sandbox does not include the main repository's `.git` directory.
- After its Claude Code session goes away, a delegate keeps running for up to two minutes before the lease stops it. Use `/delegate:cancel` to stop it at once.
- Job records live in the system temp directory, which the system clears from time to time.
- The busy-conversation check is not atomic. Two resumes of the same conversation started within the same few milliseconds can both get through.
- In `default`, agy cannot run any command, so it investigates less well than Codex does in `read-only`.
- agy's `--sandbox` flag is passed on as it is. What exactly it restricts was not tested.
- agy has no login-status command. `/delegate:setup` treats a successful `agy models` call as proof of login, which has not been tested against a logged-out agy.
- If Codex gives its final answer and then never reports the turn as finished, the job takes the turn as finished 1.5 seconds later, provided none of Codex's own agents is still at work.
- `codex app-server` is marked experimental upstream and its protocol may change between versions. This plugin was tested with codex-cli 0.170.0 and agy 1.5.12.

## License

MIT. See [LICENSE](LICENSE).
