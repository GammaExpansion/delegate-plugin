// delegate: Codex and Antigravity as Claude Code subagents.
//
// The agent types delegate:codex and delegate:agy are ordinary subagents to Claude Code:
// Claude starts them with the Agent tool, continues them with SendMessage, runs them in
// the background or in a worktree, and stops them, all as it does any subagent. Their
// model is never called. Every model request of their loops is answered here: the turn
// goes to the backend through scripts/bridge.mjs, and the backend's answer comes back as
// the subagent's report.
//
// What a delegate may do follows the permission mode of the conversation that started or
// continued it (permissions.ts), read from the spawn on every turn.
//
// What must outlive a reload of this module is in $.state: each delegate's latest spawn,
// each turn taken on, and the progress drawn under the Agent row.

import type { EngineInterface, Register, TurnStepInput } from 'claude-code'
import type { Progress, SpawnRecord, TurnRecord } from '../types'
import { AGENT_NAME, AGENT_SPECS, BACKENDS, PRODUCT, backendOfType } from './agents'
import { alive, endTurn, handBack, handBackFailed, latestMessage, say } from './answer'
import { oneLine, runTurn, type ApprovalAnswer, type ApprovalRequest } from './bridge'
import { takeOptions } from './options'
import { askedFor, describe, grantFor, type Backend, type Grant } from './permissions'

/** A delegate conversation, kept across sessions so that a resumed one can go on. */
type Conversation = { backend: Backend; sessionId: string; model: string | null; effort: string | null; at: number }

/** Agents found not to be delegates, so that their steps are passed on without a lookup. */
const notOurs = new Set<string>()
// The turns whose step has given a sign of life: their report goes in the block after it.
const beaten = new Set<string>()
/**
 * Whether a delegate's run was offered the hand-back tool, by agent, where Claude Code asked
 * about it. Outside auto mode the tool is not on a subagent's list at all, and nothing is
 * asked: its last words are its report. In auto mode the tool is offered, and may not be
 * asked about either. So a run nobody asked about hands back in auto mode only.
 */
const handBackOffered = new Map<string, boolean>()

const CONVERSATIONS_KEPT = 200
// How often a delegate's step gives a sign of life while its backend works.
const HEARTBEAT_MS = 60_000
const conversationKey = (agentId: string) => `conversation:${agentId}`

/** How much of what a delegate asks to do is shown; anything longer can only be declined. */
const SHOWN_AT_MOST = 2000

const MODELS_TOOL = [
  'Lists the model ids and reasoning efforts that the delegate:codex (OpenAI Codex) and delegate:agy (Google Antigravity) subagents accept.',
  'Use it before picking a model for a delegate with --model on the first line of its prompt, before guessing an id, and before saying that a model does not exist.',
].join(' ')

const failed = (backend: Backend, error: string) => `[delegate] ${AGENT_NAME[backend]} · failed\nerror: ${error}`

async function spawnOf($: EngineInterface, agentId: string): Promise<SpawnRecord | undefined> {
  return (await $.state.get({ plugin: 'delegate', key: 'spawn', id: agentId })).value
}

async function turnOf($: EngineInterface, turnId: string): Promise<TurnRecord | undefined> {
  return (await $.state.get({ plugin: 'delegate', key: 'turn', id: turnId })).value
}

async function setTurn($: EngineInterface, turnId: string, record: TurnRecord): Promise<void> {
  await $.state.set({ plugin: 'delegate', key: 'turn', id: turnId }, record)
}

async function delegateOf($: EngineInterface, agentId: string | undefined): Promise<Backend | undefined> {
  if (agentId === undefined || notOurs.has(agentId)) return undefined
  const known = await spawnOf($, agentId)
  if (known !== undefined) return known.backend
  const info = (await $.agent.list()).find(agent => agent.id === agentId)
  const backend = backendOfType(info?.type)
  if (backend === undefined && info !== undefined) notOurs.add(agentId)
  return backend
}

/**
 * The delegate's spawn record. Its first step can come before the agent.spawn hook has
 * written it, so it is waited for a little, and taken as unknown (default mode) after that.
 */
async function awaitSpawn($: EngineInterface, agentId: string): Promise<SpawnRecord | undefined> {
  for (let tries = 0; tries < 20; tries++) {
    const record = await spawnOf($, agentId)
    if (record !== undefined) return record
    await $.clock.sleep(100)
  }
  return undefined
}

function labelOf(backend: Backend, model: string | null, effort: string | null): string {
  if (model === null) return AGENT_NAME[backend]
  const level = effort === null ? '' : effort.toLowerCase() === 'xhigh' ? ' xHigh' : ` ${effort.toLowerCase()}`
  return `${AGENT_NAME[backend]} (${model}${level})`
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

async function loadConversation($: EngineInterface, agentId: string): Promise<Conversation | undefined> {
  const value = await $.store.get(conversationKey(agentId))
  return typeof value === 'object' && value !== null && 'sessionId' in value ? (value as Conversation) : undefined
}

async function saveConversation($: EngineInterface, agentId: string, conversation: Conversation): Promise<void> {
  await $.store.set(conversationKey(agentId), conversation)
  const keys = (await $.store.keys()).filter(key => key.startsWith('conversation:'))
  if (keys.length <= CONVERSATIONS_KEPT + 20) return
  const dated = await Promise.all(keys.map(async key => ({ key, at: ((await $.store.get(key)) as Conversation | undefined)?.at ?? 0 })))
  dated.sort((a, b) => a.at - b.at)
  for (const { key } of dated.slice(0, dated.length - CONVERSATIONS_KEPT)) await $.store.delete(key)
}

/** What a request asks for, in words that say what kind of thing it is. */
function wantsTo(request: ApprovalRequest, subject: string): string {
  switch (request.kind) {
    case 'command':
      return `run \`${subject}\`${request.cwd ? ` in ${request.cwd}` : ''}`
    case 'input':
      return `send input to the running command \`${subject}\``
    case 'network':
      return `reach ${subject}`
    case 'permissions':
      return `get more permissions: ${subject}`
    case 'edit':
      return `edit ${subject}`
    default:
      return `do this (${request.kind}): ${subject}`
  }
}

/**
 * Puts a delegate's request to the user in the engine's own question dialog, with the
 * agent's own answers to pick from (declining ones first, so that an answer the user did
 * not pick themselves never allows). A request too long to show in full can only be
 * declined. The dialog also takes free text, which no agent takes as an answer: it declines
 * the request, and the words are passed on to the agent. Words, and a dialog closed without
 * an answer, are noted for the report.
 */
async function askUser(
  $: EngineInterface,
  backend: Backend,
  request: ApprovalRequest,
  show: (line: string) => void,
  note: (line: string) => void,
): Promise<ApprovalAnswer> {
  const cut = request.title.length > SHOWN_AT_MOST
  const what = wantsTo(request, cut ? `${request.title.slice(0, SHOWN_AT_MOST)}…` : request.title)
  const short = oneLine(wantsTo(request, request.title), 300)
  const why = request.reason ? ` (${oneLine(request.reason, 300)})` : ''
  const choices = request.choices.slice(0, 4).filter(choice => !cut || !choice.allow)
  if (choices.length < 2) {
    note(`${AGENT_NAME[backend]} asked to ${short}, which could not be put to the user, so it was declined.`)
    return null
  }
  const ending = cut
    ? `It is too long to show in full, so it can only be declined.`
    : `Allow it? Or type what ${PRODUCT[backend]} should do instead.`
  show(`waiting for you: ${oneLine(what, 100)}`)
  try {
    const answer = await $.ui.ask(`${AGENT_NAME[backend]} wants to ${what}${why}. ${ending}`, {
      header: PRODUCT[backend],
      options: choices.map(choice => choice.label),
    })
    const picked = choices.find(choice => choice.label === answer)
    if (picked !== undefined) {
      if (picked.stop === true) note(`the user did not allow ${AGENT_NAME[backend]} to ${short}, and stopped it.`)
      return { choice: picked.id }
    }
    note(`the user did not allow ${AGENT_NAME[backend]} to ${short}, and wrote: "${oneLine(answer, 300)}". The words were passed on to ${PRODUCT[backend]}.`)
    return { text: answer }
  } catch {
    // Dismissed, or nobody to ask (claude -p).
    note(`asked whether ${AGENT_NAME[backend]} may ${short}, the question was closed without an answer, so it was declined.`)
    return null
  }
}

/**
 * Puts it to the user when a task asks for more than the conversation's mode gives: a
 * higher option, or commands run without the sandbox. Only their pick of Allow takes it,
 * for this one turn; anything else keeps the mode's grant. In dontAsk mode nobody is asked.
 */
async function confirmWider(
  $: EngineInterface,
  backend: Backend,
  task: string,
  base: Grant,
  wanted: Grant,
  note: (line: string) => void,
): Promise<Grant> {
  const from = describe(backend, base)
  const to = describe(backend, wanted)
  if (base.mode === 'dontAsk') {
    note(`the task asked for ${to}, more than ${base.mode} mode gives, and nobody is asked in that mode, so it ran with ${from}.`)
    return base
  }
  const keep = `Keep ${from}`
  const allow = `Allow ${to}`
  try {
    const answer = await $.ui.ask(
      `This conversation is in ${base.mode} mode, which gives ${AGENT_NAME[backend]} ${from}. The task "${oneLine(task, 160)}" asks for ${to}. Allow that for this turn?`,
      // Keep first, so that an answer the user did not pick themselves never widens.
      { header: PRODUCT[backend], options: [keep, allow] },
    )
    if (answer === allow) {
      note(`ran with ${to}, which the task asked for and the user allowed for this turn (${base.mode} mode gives ${from}).`)
      return wanted
    }
    note(
      answer === keep
        ? `the task asked for ${to}; the user kept ${from}.`
        : `the task asked for ${to}; the user answered "${oneLine(answer, 200)}", so it ran with ${from}.`,
    )
  } catch {
    note(`the task asked for ${to}; the question was closed without an answer, so it ran with ${from}.`)
  }
  return base
}

/** The report with lines added under its headline and its session line. */
function withNotes(report: string, notes: string[]): string {
  if (notes.length === 0) return report
  const lines = report.split('\n')
  const at = lines[1]?.startsWith('session: ') ? 2 : 1
  return [...lines.slice(0, at), ...notes.map(line => `note: ${line}`), ...lines.slice(at)].join('\n')
}

/** Runs one turn of a delegate on its backend and returns the report, or null if it was stopped. */
async function runDelegate(
  $: EngineInterface,
  agentId: string,
  backend: Backend,
  spawn: SpawnRecord | undefined,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<string | null> {
  const leading = takeOptions(await latestMessage($, agentId))
  if ('error' in leading) return failed(backend, leading.error)
  if (leading.task === '') return failed(backend, 'the prompt holds no task.')
  const before = await loadConversation($, agentId)
  if (leading.resume !== null && before !== undefined && before.sessionId !== leading.resume) {
    return failed(backend, `this delegate already has a conversation (session ${before.sessionId}), and one delegate is one conversation. Start a new delegate with --resume ${leading.resume} to continue that one.`)
  }
  const notes: string[] = []
  let grant = grantFor(backend, spawn?.mode ?? undefined)
  if (leading.permission !== null || leading.sandbox !== null) {
    const asked = askedFor(backend, grant, leading.permission, leading.sandbox)
    if ('error' in asked) return failed(backend, asked.error)
    grant = asked.wider ? await confirmWider($, backend, leading.task, grant, asked.grant, line => notes.push(line)) : asked.grant
  }

  const model = leading.model ?? before?.model ?? null
  const effort = leading.effort ?? before?.effort ?? null
  const info = (await $.agent.list()).find(agent => agent.id === agentId)
  const cwd = info?.cwd ?? (await $.session.cwd())
  if (!(await $.fs.exists(cwd))) {
    return failed(backend, `the directory this delegate works in is gone: ${cwd}. Claude Code removes a worktree a delegate left unchanged; start a new delegate.`)
  }

  const startedAt = Date.now()
  let label = labelOf(backend, model, null)
  const show = (status: Progress['status'], line: string) => {
    onLine(line)
    if (spawn === undefined) return
    const value: Progress = { agent: label, status, line, startedAt, endedAt: status === 'running' ? null : Date.now() }
    $.state.set({ plugin: 'delegate', key: 'progress', id: spawn.rowId }, value).catch(() => {})
  }
  show('running', 'starting')

  const outcome = await runTurn(
    $,
    {
      backend,
      cwd,
      prompt: leading.task,
      permission: grant.permission,
      sandbox: grant.sandbox,
      approvals: grant.approvals,
      mode: grant.mode,
      model,
      effort,
      resumeSessionId: leading.resume ?? before?.sessionId ?? null,
      resumeNamed: leading.resume !== null,
    },
    {
      onSession: async (sessionId, usedModel, usedEffort) => {
        label = labelOf(backend, usedModel ?? model, usedEffort)
        show('running', 'started')
        // The model and effort kept are the ones asked for, so that a conversation left
        // to the backend's default stays on it.
        await saveConversation($, agentId, { backend, sessionId, model, effort, at: Date.now() })
      },
      onActivity: line => show('running', line),
      onApproval: request =>
        grant.approvals === 'ask'
          ? askUser($, backend, request, line => show('running', line), line => notes.push(line))
          : Promise.resolve(null),
    },
  )

  if (signal.aborted) {
    show('cancelled', 'stopped')
    return null
  }
  show(outcome.status ?? 'failed', outcome.error === null ? (outcome.status ?? 'done') : oneLine(outcome.error, 100))
  return withNotes(outcome.report ?? `[delegate] ${label} · failed\nerror: ${outcome.error ?? 'unknown'}`, notes)
}

/** Whether this run of the delegate hands its report back through the tool, or says it. */
function handsBack(agentId: string, spawn: SpawnRecord | undefined): boolean {
  const asked = handBackOffered.get(agentId)
  handBackOffered.delete(agentId)
  return asked ?? spawn?.mode === 'auto'
}

/** Gives the report: through the hand-back tool where the run is offered it, else as words. */
async function* report($: EngineInterface, e: TurnStepInput, agentId: string, spawn: SpawnRecord | undefined, text: string) {
  const index = beaten.delete(e.turnId) ? 1 : 0
  if (!handsBack(agentId, spawn)) {
    await setTurn($, e.turnId, { handBackId: null, report: text })
    return yield* say(e, text, index)
  }
  return yield* handBack(e, text, id => void setTurn($, e.turnId, { handBackId: id, report: text }).catch(() => {}), index)
}

async function* delegateStep($: EngineInterface, e: TurnStepInput, agentId: string, backend: Backend, signal: AbortSignal) {
  const taken = await turnOf($, e.turnId)
  if (taken !== undefined) {
    // This turn ran already: this is the step after its hand-back call, or a step after a
    // reload of the plugin. The backend is not asked again.
    if (taken.handBackId !== null && taken.report !== null) {
      return yield* (await handBackFailed($, agentId, taken.handBackId)) ? say(e, taken.report) : endTurn(e)
    }
    if (taken.report !== null) return yield* endTurn(e)
    return yield* say(e, failed(backend, 'the plugin was reloaded while this turn ran, so its report was lost. The delegate may have done part of the work; ask it again to go on.'))
  }
  await setTurn($, e.turnId, { handBackId: null, report: null })
  const spawn = await awaitSpawn($, agentId)
  // The backend's turn, or the user's answer to a question, can take longer than Claude
  // Code lets a model request stay silent. So while it runs, the step says what the
  // delegate did last, once a minute.
  const startedAt = Date.now()
  let line = 'starting'
  const run = runDelegate($, agentId, backend, spawn, signal, latest => (line = latest)).then(
    text => ({ text }),
    (error: unknown) => ({ error }),
  )
  for (;;) {
    const settled = await Promise.race([run, $.clock.sleep(HEARTBEAT_MS).then(() => null)])
    if (settled !== null) {
      if ('error' in settled) throw settled.error
      if (settled.text === null) {
        beaten.delete(e.turnId)
        return yield* endTurn(e)
      }
      return yield* report($, e, agentId, spawn, settled.text)
    }
    beaten.add(e.turnId)
    yield alive(`${AGENT_NAME[backend]}: ${line} · ${elapsed(Date.now() - startedAt)}`)
  }
}

/** Runs the bridge for a listing or a check, and returns what it printed. */
async function bridgeText($: EngineInterface, args: string[]): Promise<string> {
  try {
    const run = await $.process.run(['node', `${$.plugin.root}/scripts/bridge.mjs`, ...args], {
      cwd: await $.session.cwd(),
      env: await $.process.hookEnv().catch(() => ({})),
      timeoutMs: 120_000,
    })
    return run.stdout.trim() || run.stderr.trim() || `The bridge exited with code ${run.exitCode}.`
  } catch (error) {
    const message = String(error)
    const hint = /ENOENT|not found/i.test(message) ? ' It needs Node.js 18.18 or later on PATH.' : ''
    return `The delegate plugin's bridge did not finish: ${message}.${hint}`
  }
}

/** A turn's id as an argument for the bridge, or none: ids are letters, digits and dashes. */
const jobArg = (text: unknown): string[] => (typeof text === 'string' && /^[A-Za-z0-9-]+$/.test(text.trim()) ? [text.trim()] : [])

const backendArg = (text: unknown): string[] => {
  const word = typeof text === 'string' ? text.trim().toLowerCase() : ''
  return word === 'codex' || word === 'agy' ? [word] : []
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The model of these agents is never called, so they need no tools of their own; the
    // hand-back tool, which the plugin calls for them, is added by Claude Code itself and
    // cannot be listed. An empty list would mean every tool, which the placeholder model
    // would get if this plugin ever failed to answer a step, and an agent whose list comes
    // to nothing is not started at all. So the list holds one tool that can do no harm:
    // Glob, which lists file names.
    for (const backend of BACKENDS) {
      await $.agent.register({ ...AGENT_SPECS[backend], model: 'haiku', omitClaudeMd: true, tools: ['Glob'] })
    }
    await $.tool.register({
      name: 'models',
      description: MODELS_TOOL,
      inputSchema: {
        type: 'object',
        properties: { backend: { type: 'string', enum: ['codex', 'agy'], description: 'One backend; both when left out.' } },
      },
    })
    // /delegate:setup and /delegate:models are markdown commands (commands/), which Claude
    // Code names with the plugin's prefix; they call this tool and the models tool.
    await $.tool.register({
      name: 'setup',
      description: 'Checks that Node and the Codex and Antigravity CLIs are installed and signed in for the delegate plugin. Takes no arguments.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'status',
      description:
        "Lists the delegate turns on record for this workspace (id, agent, status, permission, time, task), newest first. With a turn's id, shows that turn and the last lines of its log: use it to see how far a running delegate has got, or what a stopped one did. The id is the last item of a report's headline.",
      inputSchema: { type: 'object', properties: { turn: { type: 'string', description: "A turn's id, as in task-mwu2k58b3d42. All turns when left out." } } },
    })
    await $.tool.register({
      name: 'result',
      description:
        "Prints the full record of a delegate turn: its answer, the session id, every action it took and its token usage. It works for a turn that was stopped or failed half-way, which handed back no report. Without an id, the turn that ended last in this workspace.",
      inputSchema: { type: 'object', properties: { turn: { type: 'string', description: "A turn's id, as in task-mwu2k58b3d42. The last turn that ended when left out." } } },
    })
    return next(e)
  })

  // Every spawn of a delegate, the first and each one SendMessage makes to continue it,
  // carries the permission mode of the conversation at that moment.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const backend = backendOfType(e.subagentType)
    if (backend !== undefined && spawned.agentId !== undefined) {
      notOurs.delete(spawned.agentId)
      await $.state.set(
        { plugin: 'delegate', key: 'spawn', id: spawned.agentId },
        { backend, mode: e.permissionMode ?? null, rowId: e.tool_use_id },
      )
    }
    return spawned
  })

  // Learn, without changing it, whether a delegate's run is offered the hand-back tool, where asked.
  on('tool.offer', { tool: 'SubagentHandback' }, async ($, e, next) => {
    const offered = await next(e)
    if (e.agentId !== undefined && backendOfType(e.subagentType) !== undefined) handBackOffered.set(e.agentId, offered.isOffered)
    return offered
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* next(e)
    const backend = await delegateOf($, e.agentId)
    if (backend === undefined) return yield* next(e)
    return yield* delegateStep($, e, e.agentId, backend, next.signal)
  }).catch(async function* ($, e, next) {
    // Never let a delegate's step fall through to the placeholder model.
    const backend = await delegateOf($, e.agentId)
    if (backend === undefined || e.agentId === undefined) return yield* next(e)
    const why = next.error === undefined ? 'unknown' : `${next.error.kind}${next.error.message ? `: ${next.error.message}` : ''}`
    const taken = await turnOf($, e.turnId)
    if (taken?.handBackId) return yield* say(e, taken.report ?? failed(backend, `the plugin failed to run this turn (${why}).`))
    return yield* report($, e, e.agentId, await spawnOf($, e.agentId), failed(backend, `the plugin failed to run this turn (${why}).`))
  })

  // Under the Agent or SendMessage row that started a delegate turn: who, and what it did last.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'Agent' && e.props.tool !== 'SendMessage') return next(e)
    const { value } = await $.state.get({ plugin: 'delegate', key: 'progress', id: e.props.tool_use_id })
    if (value === undefined) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const row = await next(e)
    const line =
      value.status === 'running'
        ? `${value.agent} · ${elapsed(Date.now() - value.startedAt)} · ${value.line}`
        : `${value.agent} · ${value.status} · ${elapsed((value.endedAt ?? Date.now()) - value.startedAt)}`
    return (
      <Box flexDirection="column">
        {row}
        <Text dimColor>{`  ⎿ ${line}`}</Text>
      </Box>
    )
  })

  on('tool.call', { tool: 'mcp__delegate__models' }, async ($, e) => {
    const input = e as unknown as { backend?: unknown }
    return { result: await bridgeText($, ['models', ...backendArg(input.backend)]) }
  })

  on('tool.call', { tool: 'mcp__delegate__setup' }, async $ => ({ result: await bridgeText($, ['setup']) }))

  on('tool.call', { tool: 'mcp__delegate__status' }, async ($, e) => {
    const input = e as unknown as { turn?: unknown }
    return { result: await bridgeText($, ['status', ...jobArg(input.turn)]) }
  })

  on('tool.call', { tool: 'mcp__delegate__result' }, async ($, e) => {
    const input = e as unknown as { turn?: unknown }
    return { result: await bridgeText($, ['result', ...jobArg(input.turn)]) }
  })
}
