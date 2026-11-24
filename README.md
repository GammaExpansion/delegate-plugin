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

- Claude Code with mods (plugins with a hooks module). This version was tested with Claude Code 2.1.331.
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
- Five commands: `/delegate:run`, `/delegate:status`, `/delegate:result`, `/delegate:setup` and `/delegate:models`.
- One skill, `delegating-tasks`: when to delegate, how to brief a delegate, and how to handle its report.
- Four tools Claude can call: `mcp__delegate__status` and `mcp__delegate__result` for the turns on record, `mcp__delegate__models` and `mcp__delegate__setup`.
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
| `--resume <session id>`            | Continue a backend session by its id, from a new subagent. See [Conversations](#conversations). |

An option on the first line that is not in this table is an error, and nothing is started: a misspelt option, or one from an earlier version such as `--brief-file`, is not handed to the delegate as part of its task.

`--worktree` on `/delegate:run` is for Claude: it starts the subagent with Claude Code's worktree isolation.

### Conversations

One subagent is one conversation with the backend. Claude continues it with SendMessage, and the backend remembers the whole conversation. Several can run side by side, in the foreground or the background. Each subagent's backend session is kept in the plugin's store, so continuing the subagent continues the same backend session.

Every report prints the backend's own id for the conversation, as `session: <id>` under the headline. That id outlives the Claude session: in a later one, start a new delegate with `--resume <id>` on the first line and it continues that conversation; follow-ups then go by SendMessage as usual. Keep the id if a conversation is meant to last, for example a reviewer that should remember earlier rounds. A session named this way must be there: if the backend cannot load it, the turn fails with the backend's own message and no new session is started. One subagent is one conversation, so a different `--resume` sent to a subagent that already has one is refused. With `--resume` and no `--model`, the backend picks the model.

### When a turn is cut off

A turn ends early when its subagent is stopped, when the plugin is reloaded or updated, and when Claude Code is closed or restarted. No report comes back, or the subagent says that its report was lost. The work the delegate did is not lost: the backend's session holds it, and the turn is on record. To take it up again:

1. Find the turn. `/delegate:status` lists the turns of the repository; the one that was cut off reads `cancelled`, `failed`, or `running` under a process that is gone.
2. Read what it did. `/delegate:result <turn id>` prints what the delegate said and did up to then, and the `session:` id of its conversation.
3. Continue the same conversation, and say what to go on with:
   - If the subagent is still there (the same Claude session), send it a message.
   - If it is not (a new Claude session), start a new delegate of the same backend with `--resume <session id>` on the prompt's first line.

   Write `--model` and `--permission` again if the turn needs them: only the conversation is carried over.

The delegate remembers its whole conversation, the turn that was cut off included. A command that was running when the turn ended was stopped with it, so ask the delegate to check what state it left things in before it goes on.

If the backend cannot load the session any more, the turn fails and says so. That conversation is over: a new one has to be started and told what it needs to know. A session takes one turn at a time: a turn sent while another is still running on the same session is refused, and names the turn that is in the way.

### Progress and reports

While a delegate works, the line under its Agent row says who it is and what it did last:

```text
⎿ Codex Agent (gpt-6.2-astra) · 12s · command completed (exit 0): cat src/auth.ts
```

Open the subagent and its turn is a list of rows, one for each stretch of work, each with how long it took:

```text
Codex Agent · 0s · starting
Codex Agent (gpt-6.2-astra) · 4s · message: I'll run the tests, then read the three latest commits.
Codex Agent (gpt-6.2-astra) · 9s · running command: npm test
Codex Agent (gpt-6.2-astra) · 34s · command completed (exit 0): npm test
```

A row's title is what the delegate had just done when the row began, and what the row holds is the delegate's log for that stretch. A turn's first minute is shown step by step; a long turn makes about one row a minute. The rows are drawn as shell commands, because that is the kind of row Claude Code titles with a description, but no command is run for them: each shows `: progress of the delegate - this row runs no command`.

Its report is a headline that ends with the turn's id, the backend's id for the conversation, any notes, what was declined, and then the delegate's answer as it gave it:

```text
[delegate] Codex Agent (gpt-6.2-astra) · completed · 17.1s · read-only · task-mwukx33s0450
session: 01a20c1b-54c6-7a83-a5a8-327fe26d1bc2
declined (1):
- [command] touch b.txt (declined)
note: the user was asked about these and did not allow them, or the delegate was stopped before an answer came.

I couldn't create b.txt because write permission was denied.
```

### Turns on record

Every turn is recorded as it runs: what it was asked, the option it ran with, its session, a log of what the delegate did, and at the end its answer, its actions and its token usage. The last 50 turns that ended are kept for each repository, in the plugin's data folder.

```text
/delegate:status
TURN                AGENT                         STATUS      PERMISSION   TIME    TASK
task-mwukx33s0450   Codex Agent (gpt-6.2-astra)   completed   read-only    24.5s   Run `git log --oneline -2` and report the two lines. Chan...
```

- `/delegate:status` lists the turns of this repository, newest first, turns that ran in its worktrees included. `/delegate:status <id>` shows one turn and the last lines of its log: how far a running delegate has got.
- `/delegate:result <id>` prints a turn's full record. Without an id, the turn that ended last.
- A turn that was stopped, or that failed half-way, hands back no report, but its record is kept: `result` shows what it had done and said by then, and its session id.

Claude can call both as tools, so you can ask "how far is the Codex review?" or "what did the stopped run change?".

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
This conversation is in auto mode, which gives Codex Agent approve-for-me. The task asks for full-access, no sandbox. Allow that?
  Keep approve-for-me
  Allow full-access, no sandbox for this turn
  Always allow full-access, no sandbox in this conversation with Codex Agent
```

"Allow … for this turn" takes it for that turn. "Always allow" takes it for the rest of that conversation with the delegate: later turns that ask for the same or less are not put to you again, and each such report says that it ran on your earlier answer. It goes by the backend's session, so it holds when the conversation is continued with `--resume` from a later Claude session, and a new conversation starts without it. A turn must still ask: with nothing on its first line it runs with what the mode gives. Any other answer, or none, keeps the mode's option. In don't-ask mode nobody is asked: the mode's option stands unless you allowed more for that conversation earlier. Claude is told to write these options only when you ask, for example "use a full-access Codex for this, it needs adb".

### Before relying on an option

- `plan` is not "writes nothing": agy writes its plan into its own data directory, without asking.
- agy runs no commands below `auto` without asking you. In plan or don't-ask mode it runs none at all, so it cannot run `git diff` or a test; put the diff in the brief.
- `approve-for-me` and `auto` trust the backend's own judgement, which has let a write outside the workspace through.
- `full-access` and `skip-permissions` mean what they say: the delegate can touch anything your account can.
- Codex has no network in its sandbox, so `npm install` and the like need `full-access` or `--sandbox disabled`.
- In read-only mode Codex seldom asks to step outside its sandbox by itself; it tends to say it cannot. Ask it to request approval if you want it to try.

## How it works

The plugin is a mod: its hooks are a TypeScript module that runs inside Claude Code.

- `delegate:codex` and `delegate:agy` are registered as agent types, but their model does none of the work. A `turn.step` hook answers the model requests of their loops. The first of a turn reads the latest message sent to the subagent and starts the turn on the backend; while the turn runs, each request is answered with a row (a Bash call that a `tool.call` hook of the plugin answers, and that runs nothing); the one after the turn has ended is answered with the backend's answer, as the subagent's report. Outside auto mode the report is the subagent's last words. In auto mode it goes through Claude Code's hand-back tool, by a call the agent type's own model (Sonnet) makes: see [A report the review has seen](#a-report-the-review-has-seen).
- The module cannot run Node, so each turn starts `scripts/bridge.mjs`. The request goes in on stdin, events come back as JSON lines, and answers to the backend's requests go back as files in a control directory the bridge makes for the turn. That directory is in the system temp directory, where a backend's sandbox can write, so every file the bridge reads must carry a random token it sent to the module on stdout alone: a delegate cannot answer its own request. When the subagent is stopped, the bridge is stopped, and it interrupts the backend.
- The permission mode comes with every spawn of the subagent, the first and each continuation, so a delegate follows a mode you switch to between turns.
- Each subagent's backend session id is kept in the plugin's store, so a continued conversation resumes the same backend session. A session that can no longer be resumed fails the turn, and nothing is started in its place: a delegate that has lost what it knew does not carry on as if it had not.
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
│   ├── bridge.mjs       one turn per process; status, result, models and setup
│   └── lib/             JSON-RPC client, the two backends, the records of turns, the report
├── commands/            run, status, result, setup, models
├── skills/              delegating-tasks
├── types/index.d.ts     the progress value the hooks keep in $.state
└── tests/               the mod's own tests (claude plugin test)
```

To see what a backend really sent, set `DELEGATE_TRACE=1` where Claude Code starts: every JSON-RPC message of a turn goes to a new `delegate-trace-…` directory in the system temp directory, which the report names. The trace holds the prompt and everything the delegate read or wrote.

## Design decisions

### A delegate is a native subagent

Earlier versions had a forwarding subagent run a script in a loop: start a job, wait on it in short calls, read the answer from a file. Every step was a model call, and background runs, follow-ups, stopping and worktrees each needed machinery of their own. Now Claude Code's own subagent does all of that, and the plugin answers for the subagent's model. No model sits between Claude and the delegate while it works.

### A turn is many short steps

Claude Code ends a background subagent whose model request has been silent for ten minutes, and a delegate's turn can be silent for much longer: one long command, or a question waiting for you. So the plugin does not hold one request open for the whole turn. The turn runs on by itself, and each request of the subagent's loop is answered at once with a row: a tool call the plugin writes and then answers itself, when the delegate has done something more. The last request is answered with the report. A turn can take as long as the backend takes, and what it did on the way can be read row by row.

### A report the review has seen

In auto mode Claude Code reviews what a subagent did before its report reaches the conversation, and it does so through the reply of the subagent's model that hands the report back. A report the plugin handed back itself had no such reply behind it, and arrived under a note that the review was unavailable. So in auto mode the agent type's model is called once per turn, at the end. The report is in front of it as the result of the last row, and its only instruction is to hand that back unchanged. The plugin holds the model's reply until it is whole and lets it through only if it is a hand-back of the report as it is, to the character. Anything else is dropped, and the plugin hands the report back itself, under the note, as before.

The call reads about 7,000 tokens and the report, and writes the report out once more: two seconds for a report of a line, half a minute for one of 18,000 characters. A report longer than 20,000 characters is not put to the model: Claude Code would show it only the beginning, and copying it would cost too much. Such a report still arrives under the note.

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
- A turn lives inside its subagent. Stopping the subagent, a reload or an update of the plugin, or quitting Claude Code ends the turn in flight, and a stopped turn hands back no report. The backend's session stays: continue it with SendMessage, or in a later Claude session with `--resume` and the id from an earlier report.
- The records of turns are for looking, not for running: `status` and `result` show a turn, but nothing can take a stopped turn up where it left off, other than continuing its conversation.
- In auto mode a report longer than 20,000 characters, and one the model did not hand back unchanged, arrives under a note that the auto mode classifier was unavailable when reviewing the subagent's work. The note is accurate: that report was not reviewed by Claude Code, and Claude is told to check it. In other modes no such review runs and no note appears.
- In auto mode each turn makes one call of the agent type's model (Sonnet) to hand its report back, which is billed like any subagent's call. In other modes no model is called.
- The subagent's panel names the model of the agent type (Sonnet), not the backend's model. The report's headline names the real one.
- A turn's rows are drawn as shell commands, and the agent types list the Bash tool for it. No command of a delegate's ever runs: the plugin answers the rows it wrote itself and refuses any other.
- A message sent to a delegate while its turn runs is not passed on to the backend. The report names it, so that it can be sent again.
- A turn that nothing follows for four minutes is stopped by its bridge, with a note in its record. That is how a turn ends when its subagent went away between two steps; a machine that slept is not counted.
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
