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

import type { EngineInterface, Register, TurnStepInput } from 'claude-code'
import type { Progress } from '../types'
import { AGENT_NAME, AGENT_SPECS, BACKENDS, PRODUCT, backendOfType } from './agents'
import { endTurn, handBack, handBackFailed, latestMessage, say } from './answer'
import { oneLine, runTurn, type ApprovalAnswer, type ApprovalRequest } from './bridge'
import { takeOptions } from './options'
import { askedFor, describe, grantFor, type Backend, type Grant, type Settings } from './permissions'

/** What the latest spawn of a delegate said: the backend, the mode, and the row it came from. */
type Spawn = { backend: Backend; mode: string | undefined; rowId: string }

/** A delegate conversation, kept across sessions so that a resumed one can go on. */
type Conversation = { backend: Backend; sessionId: string; model: string | null; effort: string | null; at: number }

const spawns = new Map<string, Spawn>()
const notOurs = new Set<string>()
/** Hand-back calls made, by turn, to check on the step after. */
const handedBack = new Map<string, { id: string; report: string }>()

const CONVERSATIONS_KEPT = 200
const conversationKey = (agentId: string) => `conversation:${agentId}`

const MODELS_TOOL = [
  'Lists the model ids and reasoning efforts that the delegate:codex (OpenAI Codex) and delegate:agy (Google Antigravity) subagents accept.',
  'Use it before picking a model for a delegate with --model on the first line of its prompt, before guessing an id, and before saying that a model does not exist.',
].join(' ')

async function delegateOf($: EngineInterface, agentId: string | undefined): Promise<Backend | undefined> {
  if (agentId === undefined || notOurs.has(agentId)) return undefined
  const known = spawns.get(agentId)
  if (known !== undefined) return known.backend
  const info = (await $.agent.list()).find(agent => agent.id === agentId)
  const backend = backendOfType(info?.type)
  if (backend === undefined && info !== undefined) notOurs.add(agentId)
  return backend
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

/**
 * Puts a delegate's request to the user in the engine's own question dialog, with the
 * agent's own answers to pick from (declining ones first, so that an answer the user did
 * not pick themselves never allows). The dialog also takes free text, which no agent takes
 * as an answer: it declines the request, and the words are passed on to the agent. Words,
 * and a dialog closed without an answer, are noted for the report.
 */
async function askUser(
  $: EngineInterface,
  backend: Backend,
  request: ApprovalRequest,
  show: (line: string) => void,
  note: (line: string) => void,
): Promise<ApprovalAnswer> {
  const what =
    request.kind === 'command'
      ? `run \`${oneLine(request.title, 300)}\`${request.cwd ? ` in ${request.cwd}` : ''}`
      : request.kind === 'edit'
        ? `edit ${oneLine(request.title, 300)}`
        : `do this (${request.kind}): ${oneLine(request.title, 300)}`
  const why = request.reason ? ` (${oneLine(request.reason, 200)})` : ''
  const choices = request.choices.slice(0, 4)
  if (choices.length < 2) return null
  show(`waiting for you: ${oneLine(what, 100)}`)
  try {
    const answer = await $.ui.ask(
      `${AGENT_NAME[backend]} wants to ${what}${why}. Allow it? Or type what ${PRODUCT[backend]} should do instead.`,
      { header: PRODUCT[backend], options: choices.map(choice => choice.label) },
    )
    const picked = choices.find(choice => choice.label === answer)
    if (picked !== undefined) {
      if (picked.stop === true) note(`the user did not allow ${AGENT_NAME[backend]} to ${what}, and stopped it.`)
      return { choice: picked.id }
    }
    note(`the user did not allow ${AGENT_NAME[backend]} to ${what}, and wrote: "${oneLine(answer, 300)}". The words were passed on to ${PRODUCT[backend]}.`)
    return { text: answer }
  } catch {
    // Dismissed, or nobody to ask (claude -p).
    note(`asked whether ${AGENT_NAME[backend]} may ${what}, the question was closed without an answer, so it was declined.`)
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
      `This conversation is in ${base.mode} mode, which gives ${AGENT_NAME[backend]} ${from}. The task asks for ${to}. Allow that for this turn?`,
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

/** The report with lines added under its headline. */
function withNotes(report: string, notes: string[]): string {
  if (notes.length === 0) return report
  const [headline = '', ...rest] = report.split('\n')
  return [headline, ...notes.map(line => `note: ${line}`), ...rest].join('\n')
}

/** Runs one turn of a delegate on its backend and returns the report, or null if it was stopped. */
async function runDelegate($: EngineInterface, agentId: string, backend: Backend, signal: AbortSignal, settings: Settings): Promise<string | null> {
  const spawn = spawns.get(agentId)
  const leading = takeOptions(await latestMessage($, agentId))
  if (leading.task === '') return `[delegate] ${AGENT_NAME[backend]} · failed\nerror: the prompt holds no task.`
  const notes: string[] = []
  let grant = grantFor(backend, spawn?.mode, settings)
  if (leading.permission !== null || leading.sandbox !== null) {
    const asked = askedFor(backend, grant, leading.permission, leading.sandbox)
    if ('error' in asked) return `[delegate] ${AGENT_NAME[backend]} · failed\nerror: ${asked.error}`
    grant = asked.wider ? await confirmWider($, backend, grant, asked.grant, line => notes.push(line)) : asked.grant
  }

  const before = await loadConversation($, agentId)
  const model = leading.model ?? before?.model ?? null
  const effort = leading.effort ?? before?.effort ?? null
  const info = (await $.agent.list()).find(agent => agent.id === agentId)
  const cwd = info?.cwd ?? (await $.session.cwd())

  const startedAt = Date.now()
  let label = labelOf(backend, model, null)
  const show = (status: Progress['status'], line: string) => {
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
      resumeSessionId: before?.sessionId ?? null,
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

  const report = withNotes(outcome.report ?? `[delegate] ${label} · failed\nerror: ${outcome.error ?? 'unknown'}`, notes)
  return report
}

async function* delegateStep($: EngineInterface, e: TurnStepInput, agentId: string, backend: Backend, signal: AbortSignal, settings: Settings) {
  const sent = handedBack.get(e.turnId)
  if (sent !== undefined) {
    handedBack.delete(e.turnId)
    return yield* (await handBackFailed($, agentId, sent.id)) ? say(e, sent.report) : endTurn(e)
  }
  const report = await runDelegate($, agentId, backend, signal, settings)
  if (report === null) return yield* endTurn(e)
  return yield* handBack(e, report, id => handedBack.set(e.turnId, { id, report }))
}

/** Runs the bridge for a listing or a check, and returns what it printed. */
async function bridgeText($: EngineInterface, args: string[]): Promise<string> {
  try {
    const run = await $.process.run(['node', `${$.plugin.root}/scripts/bridge.mjs`, ...args], {
      cwd: await $.session.cwd(),
      timeoutMs: 120_000,
    })
    return (run.stdout.trim() || run.stderr.trim() || `The bridge exited with code ${run.exitCode}.`)
  } catch (error) {
    return `Could not run Node for the delegate plugin: ${String(error)}. It needs Node.js 18.18 or later on PATH.`
  }
}

const backendArg = (text: unknown): string[] => {
  const word = typeof text === 'string' ? text.trim().toLowerCase() : ''
  return word === 'codex' || word === 'agy' ? [word] : []
}

export const register: Register = (on, options) => {
  const settings: Settings = { codexSandbox: options.codexSandbox === 'off' ? 'off' : 'on' }

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
    // A plugin's own command is run as /<name>, with no plugin prefix, so the names carry it.
    await $.command.register({ name: 'delegate-setup', description: 'Check that Node and the Codex and Antigravity CLIs are ready for delegate' })
    await $.command.register({ name: 'delegate-models', description: 'List the models Codex and Antigravity accept', argumentHint: '[codex|agy]' })
    return next(e)
  })

  // Every spawn of a delegate, the first and each one SendMessage makes to continue it,
  // carries the permission mode of the conversation at that moment.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const backend = backendOfType(e.subagentType)
    if (backend !== undefined && spawned.agentId !== undefined) {
      spawns.set(spawned.agentId, { backend, mode: e.permissionMode, rowId: e.tool_use_id })
      notOurs.delete(spawned.agentId)
    }
    return spawned
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* next(e)
    const backend = await delegateOf($, e.agentId)
    if (backend === undefined) return yield* next(e)
    return yield* delegateStep($, e, e.agentId, backend, next.signal, settings)
  }).catch(async function* ($, e, next) {
    // Never let a delegate's step fall through to the placeholder model.
    const backend = await delegateOf($, e.agentId)
    if (backend === undefined) return yield* next(e)
    const why = next.error === undefined ? 'unknown' : `${next.error.kind}${next.error.message ? `: ${next.error.message}` : ''}`
    const report = `[delegate] ${AGENT_NAME[backend]} · failed\nerror: the plugin failed to run this turn (${why}).`
    if (handedBack.has(e.turnId)) return yield* say(e, report)
    return yield* handBack(e, report, id => handedBack.set(e.turnId, { id, report }))
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

  on('command.run', { command: 'delegate-setup' }, async $ => ({ text: await bridgeText($, ['setup']), isTextDisplayOnly: true }))

  on('command.run', { command: 'delegate-models' }, async ($, e) => ({
    text: await bridgeText($, ['models', ...backendArg(e.args)]),
    isTextDisplayOnly: true,
  }))
}
