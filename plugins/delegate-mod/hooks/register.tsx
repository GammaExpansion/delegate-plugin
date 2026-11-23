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
import { HANDBACK, endTurn, handBack, handBackFailed, latestMessage, say } from './answer'
import { oneLine, runTurn, type ApprovalRequest } from './bridge'
import { takeOptions } from './options'
import { grantFor, type Backend } from './permissions'

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

/** Puts a delegate's request to the user, in the engine's own question dialog. */
async function askUser($: EngineInterface, backend: Backend, request: ApprovalRequest, show: (line: string) => void): Promise<boolean> {
  const what =
    request.kind === 'command'
      ? `run \`${oneLine(request.title, 300)}\`${request.cwd ? ` in ${request.cwd}` : ''}`
      : request.kind === 'edit'
        ? `edit ${oneLine(request.title, 300)}`
        : `do this (${request.kind}): ${oneLine(request.title, 300)}`
  const why = request.reason ? ` (${oneLine(request.reason, 200)})` : ''
  show(`waiting for you: ${oneLine(what, 100)}`)
  try {
    const picked = await $.ui.ask(`${AGENT_NAME[backend]} wants to ${what}${why}. Allow it?`, {
      header: PRODUCT[backend],
      // Deny first, so that an answer the user did not pick themselves never allows.
      options: ['Deny', 'Allow'],
    })
    return picked === 'Allow'
  } catch {
    // Dismissed, or nobody to ask (claude -p).
    return false
  }
}

/** Runs one turn of a delegate on its backend and returns the report, or null if it was stopped. */
async function runDelegate($: EngineInterface, agentId: string, backend: Backend, signal: AbortSignal): Promise<string | null> {
  const spawn = spawns.get(agentId)
  const grant = grantFor(backend, spawn?.mode)
  const leading = takeOptions(await latestMessage($, agentId))
  if (leading.task === '') return `[delegate] ${AGENT_NAME[backend]} · failed\nerror: the prompt holds no task.`

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
        grant.approvals === 'ask' ? askUser($, backend, request, line => show('running', line)) : Promise.resolve(false),
    },
  )

  if (signal.aborted) {
    show('cancelled', 'stopped')
    return null
  }
  show(outcome.status ?? 'failed', outcome.error === null ? (outcome.status ?? 'done') : oneLine(outcome.error, 100))

  let report = outcome.report ?? `[delegate] ${label} · failed\nerror: ${outcome.error ?? 'unknown'}`
  if (leading.setAside.length > 0) {
    const [headline = '', ...rest] = report.split('\n')
    const note = `note: ${leading.setAside.join(', ')} was set aside. What a delegate may do follows this conversation's permission mode (${grant.mode}), which gave it ${grant.permission}.`
    report = [headline, note, ...rest].join('\n')
  }
  return report
}

async function* delegateStep($: EngineInterface, e: TurnStepInput, agentId: string, backend: Backend, signal: AbortSignal) {
  const sent = handedBack.get(e.turnId)
  if (sent !== undefined) {
    handedBack.delete(e.turnId)
    return yield* (await handBackFailed($, agentId, sent.id)) ? say(e, sent.report) : endTurn(e)
  }
  const report = await runDelegate($, agentId, backend, signal)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The model of these agents is never called, so they need no tools: the one listed is
    // the hand-back tool, which the plugin calls for them. An empty list would mean every
    // tool, and the placeholder model would get them all if this plugin ever failed to
    // answer a step.
    for (const backend of BACKENDS) {
      await $.agent.register({ ...AGENT_SPECS[backend], model: 'haiku', omitClaudeMd: true, tools: [HANDBACK] })
    }
    await $.tool.register({
      name: 'models',
      description: MODELS_TOOL,
      inputSchema: {
        type: 'object',
        properties: { backend: { type: 'string', enum: ['codex', 'agy'], description: 'One backend; both when left out.' } },
      },
    })
    await $.command.register({ name: 'setup', description: 'Check that Node and the Codex and Antigravity CLIs are ready for delegate' })
    await $.command.register({ name: 'models', description: 'List the models Codex and Antigravity accept', argumentHint: '[codex|agy]' })
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
    return yield* delegateStep($, e, e.agentId, backend, next.signal)
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

  on('command.run', { command: 'setup' }, async $ => ({ text: await bridgeText($, ['setup']), isTextDisplayOnly: true }))

  on('command.run', { command: 'models' }, async ($, e) => ({
    text: await bridgeText($, ['models', ...backendArg(e.args)]),
    isTextDisplayOnly: true,
  }))
}
