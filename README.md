# delegate

Hand a task from Claude Code to another vendor's coding agent, as a Claude Code subagent. Two backends are supported:

| Subagent         | Agent                                  | Protocol                            |
| ---------------- | -------------------------------------- | ----------------------------------- |
| `delegate:codex` | OpenAI Codex (GPT models)              | `codex app-server` (stdio JSON-RPC) |
| `delegate:agy`   | Google Antigravity (Gemini models)     | `agy acp` (Agent Client Protocol)   |

A delegate behaves like any other subagent: Claude starts it with the Agent tool, continues it with SendMessage, runs it in the background or in a worktree, and you stop it the way you stop any subagent. What it may do follows your conversation's permission mode, and when it asks for more, you are asked.

The plugin stores no credentials. It uses the login and configuration each CLI already has on the machine.

## Install

### What you need

- Claude Code with mods (plugins with a hooks module). This version was tested with Claude Code 2.1.330.
- Node.js 18.18 or later on `PATH`.
- At least one of the two agent CLIs, installed and signed in (or set up with an API key):

| Backend     | Install                                                                 | Sign in                                                                 |
| ----------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Codex       | `npm install -g @openai/codex`                                          | `codex login`, or a model provider with an API key in `~/.codex/config.toml` |
| Antigravity | the Antigravity CLI, so that `agy` is on `PATH`                         | run `agy` once and sign in, or its Gemini API key or gateway setup      |

### Install the plugin

In Claude Code:

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

### Check that it works

```text
/delegate:setup
```

```text
node: 22.23.5 (ok)
codex: ready · codex-cli 0.171.0
agy: ready · 1.5.15
```

A backend that is not ready has a line under it that says what to do. `ready (custom provider)` means Codex runs on a model provider of your own, which needs no OpenAI login; its key is checked by the first task. Then try:

```text
Ask Codex what this repository does, in three sentences
```

### What it adds

- Two subagent types, `delegate:codex` and `delegate:agy`.
- Three commands: `/delegate:run`, `/delegate:setup` and `/delegate:models`.
- One skill, `delegating-tasks`: when to delegate, how to brief a delegate, and how to handle its report.
- Two tools Claude can call, `mcp__delegate__models` and `mcp__delegate__setup`.
- A hooks module that runs the delegates, puts their requests to you, and shows their progress under the Agent row.

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

To work on the plugin, load it from a clone instead of installing it:

```bash
claude --plugin-dir /path/to/delegate-plugin/plugins/delegate
```

## Usage

Ask in plain language, and Claude picks the subagent:

```text
Ask Codex whether the token refresh logic in src/auth.ts has a race condition
Have Gemini review the diff in the background
```

Or use the command:

```text
/delegate:run codex find out why tests/session.test.ts fails intermittently
/delegate:run agy --worktree fix the bug in math.js
/delegate:models
```

A prompt may carry options on its first line, before the task. Claude writes them when you ask for them:

| Option                             | Effect                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `--model <id>`                     | The model. `/delegate:models` lists the ids. Left out, the backend's default; a continued conversation keeps its model. |
| `--effort <level>`                 | Codex's reasoning effort. An Antigravity id carries its thinking level, as in `gemini-4-argon-high`. |
| `--permission <option>`            | Another permission option than the mode gives, for this turn. See [Asking for more or less](#asking-for-more-or-less). |
| `--sandbox enabled` or `disabled`  | Another sandbox than the option has, for this turn.                                            |

`--worktree` on `/delegate:run` is for Claude: it starts the subagent with Claude Code's worktree isolation.

### Conversations

One subagent is one conversation with the backend. Claude continues it with SendMessage, and the backend remembers the whole conversation. Several can run side by side, in the foreground or the background. Each subagent's backend session is kept in the plugin's store, so continuing the subagent continues the same backend session.

### Progress and reports

While a delegate works, the line under its Agent row says who it is and what it did last:

```text
⎿ Codex Agent (gpt-6.2-astra) · 12s · command completed (exit 0): cat src/auth.ts
```

Its report is a headline, any notes, what was declined, and then the delegate's answer as it gave it:

```text
[delegate] Codex Agent (gpt-6.2-astra) · completed · 17.1s · read-only
declined (1):
- [command] touch b.txt (declined)
note: the user was asked about these and did not allow them, or the delegate was stopped before an answer came.

I couldn't create b.txt because write permission was denied.
```

## Permissions

A delegate runs under one of its backend's own permission options, picked from the permission mode your conversation is in when the delegate starts or is continued:

| Your conversation's mode | Codex              | Antigravity        | A request beyond the option |
| ------------------------ | ------------------ | ------------------ | --------------------------- |
| plan                     | `read-only`        | `plan`             | declined                    |
| default                  | `read-only`        | `default`          | you are asked               |
| accept edits             | `ask-for-approval` | `accept-edits`     | you are asked               |
| auto                     | `approve-for-me`   | `auto`             | declined                    |
| bypass permissions       | `full-access`      | `skip-permissions` | (nothing is asked)          |
| don't ask                | `read-only`        | `default`          | declined                    |

In auto mode Claude Code asks you nothing and leaves it to its classifier; a delegate there leaves it to its backend's own reviewer, and declines what that leaves over. What was declined is in the report.

### What each option means

**Codex**

| Option             | Sandbox                                                          | When Codex asks                                       |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------- |
| `read-only`        | Cannot write, no network. Commands that only read still run.     | Before anything more.                                 |
| `ask-for-approval` | Can write to the workspace and temp directories. No network.     | Before stepping outside the sandbox.                  |
| `approve-for-me`   | The same.                                                        | The same, but its own automatic reviewer answers.     |
| `full-access`      | None. Network included.                                          | Never.                                                |

**Antigravity**

| Option             | What agy does without asking                                     | What it asks about                                   |
| ------------------ | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `plan`             | Reads and searches, and writes a plan into its own data directory. | Edits and commands.                                |
| `default`          | Reads and searches.                                              | Every edit and every command.                        |
| `accept-edits`     | Edits files in the workspace.                                    | Every command, and anything outside the workspace.   |
| `auto`             | Edits files and runs commands.                                   | What it judges risky.                                |
| `skip-permissions` | Everything (`--dangerously-skip-permissions`).                   | Nothing.                                             |

agy has a sandbox of its own, off unless asked for: `--sandbox enabled` restricts its terminal. Its `auto` always runs commands in that sandbox, so `auto` cannot go with `--sandbox disabled`. Where agy does not offer `auto` (its sandbox cannot run on the machine, or the account is not offered the mode), the turn runs with `accept-edits` instead, and the report says so.

### When a delegate asks

Where you are asked, the question shows the backend's own answers, declining ones first:

| Codex                                       | Antigravity                     |
| ------------------------------------------- | ------------------------------- |
| No, continue without it                     | No, continue without it         |
| Yes, just this once                         | Yes, just this once             |
| Yes, and don't ask again in this session    |                                 |
| No, and stop Codex                          | No, and stop Antigravity        |

The backend waits for your answer. Codex's "don't ask again in this session" lasts as long as its process, which is the one task it was started for. agy offers only allow and deny. Codex can also ask for more permissions for the rest of the turn (paths it may write, network access); the question lists them, and "yes" grants them for that turn. A request too long to show in full (over 2,000 characters) can only be declined.

The question also takes text of your own. That declines the request, and your words go to the delegate: to Codex at once, into the running turn, and to agy right after its turn. The report notes what you wrote.

### Asking for more or less

A task can ask for another option or sandbox with `--permission` and `--sandbox` on its prompt's first line. Less than your mode gives (a lower option, or a sandbox) is taken as it is. More (a higher option, or Codex without its sandbox) is put to you first:

```text
This conversation is in auto mode, which gives Codex Agent approve-for-me. The task asks for full-access, no sandbox. Allow that for this turn?
  Keep approve-for-me
  Allow full-access, no sandbox
```

Only "Allow" takes it, and only for that turn. In don't-ask mode nobody is asked, and the mode's option stands. Claude is told to write these options only when you ask, for example "use a full-access Codex for this, it needs adb".

### Before relying on an option

- `plan` is not "writes nothing": agy writes its plan into its own data directory, without asking.
- agy runs no commands below `auto` without asking you. In plan or don't-ask mode it runs none at all, so it cannot run `git diff` or a test; put the diff in the brief.
- `approve-for-me` and `auto` trust the backend's own judgement, which has let a write outside the workspace through.
- `full-access` and `skip-permissions` mean what they say: the delegate can touch anything your account can.
- Codex has no network in its sandbox, so `npm install` and the like need `full-access` or `--sandbox disabled`.
- In read-only mode Codex seldom asks to step outside its sandbox by itself; it tends to say it cannot. Ask it to request approval if you want it to try.

## How it works

The plugin is a mod: its hooks are a TypeScript module that runs inside Claude Code.

- `delegate:codex` and `delegate:agy` are registered as agent types, but their model is never called. A `turn.step` hook answers every model request of their loops: it reads the latest message sent to the subagent, runs the turn on the backend, and returns the backend's answer as the subagent's report. Where Claude Code offers the subagent its hand-back tool (in auto mode), the report goes through it; elsewhere it is the subagent's last words.
- The module cannot run Node, so each turn starts `scripts/bridge.mjs`. The request goes in on stdin, events come back as JSON lines, and answers to the backend's requests go back as files in a control directory the bridge makes for the turn. That directory is in the system temp directory, where a backend's sandbox can write, so every file the bridge reads must carry a random token it sent to the module on stdout alone: a delegate cannot answer its own request. When the subagent is stopped, the bridge is stopped, and it interrupts the backend.
- The permission mode comes with every spawn of the subagent, the first and each continuation, so a delegate follows a mode you switch to between turns.
- Each subagent's backend session id is kept in the plugin's store, so a continued conversation resumes the same backend session. A session that can no longer be resumed is replaced by a new one, and the report says so.
- What a reload of the plugin must not lose (each subagent's mode, each turn taken on, the progress line) is in Claude Code's session state, and a turn is never run twice.

```text
plugins/delegate/
├── .claude-plugin/plugin.json
├── hooks/
│   ├── register.tsx     the hooks: agent types, turn.step, questions, progress, tools
│   ├── agents.ts        the two agent types as Claude sees them
│   ├── answer.ts        answering a model request in place of the model
│   ├── bridge.ts        running a turn through the bridge
│   ├── permissions.ts   mode → option, and what a task may ask for
│   └── options.ts       the options on a prompt's first line
├── scripts/
│   ├── bridge.mjs       one turn per process; models and setup
│   └── lib/             JSON-RPC client, the two backends, the report
├── commands/            run, setup, models
├── skills/              delegating-tasks
├── types/index.d.ts     the progress value the hooks keep in $.state
└── tests/               the mod's own tests (claude plugin test)
```

To see what a backend really sent, set `DELEGATE_TRACE=1` where Claude Code starts: every JSON-RPC message of a turn goes to a new `delegate-trace-…` directory in the system temp directory, which the report names. The trace holds the prompt and everything the delegate read or wrote.

## Design decisions

### A delegate is a native subagent

Earlier versions had a forwarding subagent run a script in a loop: start a job, wait on it in short calls, read the answer from a file. Every step was a model call, and background runs, follow-ups, stopping and worktrees each needed machinery of their own. Now Claude Code's own subagent does all of that, and the plugin answers for the subagent's model. No model sits between Claude and the delegate.

### Permissions follow the mode, and more needs your pick

Earlier versions had Claude write the permission option on every request, and nothing in code held it to the conversation. Now the mode decides, from what Claude Code reports at each spawn. A task can still ask for something else, but more than the mode gives takes your answer in a question, and only "Allow" counts: a dismissed question, text of your own, or a session where nobody can be asked keeps the mode's option.

### The backend's own answers, and your words when you have them

The question offers the backend's own answers rather than a yes and a no, so that "stop" and "don't ask again" mean what they mean to the backend. Claude Code's question dialog always takes text as well; rather than ignore it, the plugin declines the request and hands your words to the delegate.

## Tests

```bash
node --test
```

```bash
claude plugin test plugins/delegate
```

`node --test` runs the bridge and both backends against stand-ins for `codex app-server` and `agy acp` (`tests/fixtures/`), so it needs neither CLI. `claude plugin test` runs the mod's own tests. The behaviour of the real backends, and of the hooks inside Claude Code, was checked by hand.

## Adding a backend

Add a file in `scripts/lib/backends/` and register it in `index.mjs`. It needs:

- `permissions`, keyed by the names `--permission` takes, and `defaultPermission`.
- `settingsFor({ permission, sandbox })`, which checks a choice and returns its settings, and throws on an option the backend lacks.
- `check()` (may be async): installed, version, and login state.
- `listModels({ cwd })`: `{ models, defaultModel, defaultEffort, note }`.
- `run({ cwd, prompt, permission, sandbox, model, effort, resumeSessionId, signal, traceFile, onEvent, onApproval })`, which runs one turn and returns `{ status, sessionId, model, text, actions, usage, error, notes? }`. When the agent asks for approval, call `onApproval` with the request and the answers to offer (`choices`, declining ones first, at most four); it resolves to a choice's id, or to `{ text }` (decline, and pass the words on), or to null (decline). When `signal` aborts, interrupt the turn and return within the grace period in `lib/abort.mjs`.

Then add it to `hooks/agents.ts` (its agent type), `hooks/permissions.ts` (its options per mode) and `hooks/register.tsx` where the backends are named.

## Known limitations

- Mods are an early-access part of Claude Code, and their API may change between releases.
- In auto mode the report goes through Claude Code's internal hand-back tool, which is not part of the documented API.
- In auto mode every report arrives under a note that the auto mode classifier was unavailable when reviewing the subagent's work. Claude Code reviews a subagent's report through its own model's reply, and a delegate's report is not written by that model, so there is nothing for it to review. The note is accurate: the delegate's work was not reviewed by Claude Code, and Claude is told to check it. The plugin cannot remove it; in other modes no such review runs and no note appears.
- The subagent's panel names the placeholder model of the agent type (Haiku), not the backend's model. The report's headline names the real one.
- Claude Code's question dialog always has a field for text; it cannot be left out.
- What you set up in a backend itself still applies on top of the mode's option: Codex's exec-policy rules and MCP approval settings, agy's allow-lists. A mode is not a guarantee against them.
- A delegate's answer is passed on as it is, after the plugin's own lines, so it could imitate a `note:` line. Claude is told to treat it as another model's work.
- In Claude Code on the web, choosing "Accept edits" was seen to reach the plugin as default mode, so the delegate ran with the default mode's option.
- Codex's "don't ask again in this session" lasts one task, since each task starts a new Codex process.
- agy runs a slow command in the background and ends its turn before the command has finished. The turn waits for it to carry on, up to 30 minutes without a sign of life (`DELEGATE_AGY_BACKGROUND_WAIT_SEC`) or two hours in all (`DELEGATE_AGY_BACKGROUND_MAX_SEC`). What agy had said by then is the answer, with a note.
- A command agy starts to keep running (a server, an emulator) is not waited for, and keeps running after the turn. The report names it.
- agy answers a resumed session's `session/load` while it is still replaying the history, so a resumed turn waits for a second of quiet before it sends the prompt.
- Below `full-access`, Codex cannot commit inside a worktree: its sandbox does not include the main repository's `.git` directory.
- agy's default model may not be available on every account or gateway; name one with `--model` if a task fails with "not found".
- Tested on Linux with codex-cli 0.171.0 and agy 1.5.15. `codex app-server` is marked experimental upstream. Windows and `claude -p` were not tested with this version.

## License

MIT. See [LICENSE](LICENSE).
