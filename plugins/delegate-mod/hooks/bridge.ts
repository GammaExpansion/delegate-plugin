// Runs one delegate turn through scripts/bridge.mjs, the plugin's Node half: the request
// goes in on stdin, events come back as JSON lines, and answers to the delegate's requests
// for approval go back as files in the control directory the bridge names first.

import type { EngineInterface } from 'claude-code'
import type { Approvals, Backend } from './permissions'

export type TurnRequest = {
  backend: Backend
  cwd: string
  prompt: string
  permission: string
  /** "disabled" to run Codex without its sandbox; null for the option's own. */
  sandbox: 'disabled' | null
  approvals: Approvals
  mode: string
  model: string | null
  effort: string | null
  resumeSessionId: string | null
}

export type Action = { kind: string; title: string; status?: string; exitCode?: number | null; permission?: string }

export type ApprovalRequest = { kind: string; title: string; cwd: string | null; reason: string | null }

type BackendEvent =
  | { type: 'session'; sessionId: string; model: string | null; effort?: string | null }
  | { type: 'action'; action: Action; output?: string }
  | { type: 'progress'; text: string }
  | { type: 'note'; text: string }

type RunResult = { status: 'completed' | 'cancelled' | 'failed'; sessionId: string | null; model: string | null }

type BridgeEvent =
  | { type: 'ready'; controlDir: string }
  | { type: 'event'; event: BackendEvent }
  | { type: 'approval'; id: number; request: ApprovalRequest }
  | { type: 'result'; result: RunResult; report: string }
  | { type: 'error'; message: string }

export type TurnHooks = {
  /** The backend opened or resumed its session: keep the id to continue it next turn. */
  onSession: (sessionId: string, model: string | null, effort: string | null) => Promise<void>
  /** What the delegate did last, in one line. */
  onActivity: (line: string) => void
  /** Resolves true to allow the request. */
  onApproval: (request: ApprovalRequest) => Promise<boolean>
}

export type TurnOutcome = { report: string | null; status: RunResult['status'] | null; error: string | null }

export function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The one line a backend event makes under the delegate's row, or null for none. */
function activityOf(event: BackendEvent): string | null {
  switch (event.type) {
    case 'progress':
      return oneLine(event.text)
    case 'action': {
      const { kind, title, status, exitCode } = event.action
      const exit = exitCode === undefined || exitCode === null ? '' : ` (exit ${exitCode})`
      return oneLine(`${kind}${status ? ` ${status}` : ''}${exit}: ${title}`)
    }
    case 'note':
      return oneLine(event.text)
    default:
      return null
  }
}

export async function runTurn($: EngineInterface, request: TurnRequest, hooks: TurnHooks): Promise<TurnOutcome> {
  const stream = $.process.spawn({
    argv: ['node', `${$.plugin.root}/scripts/bridge.mjs`, 'run'],
    cwd: request.cwd,
    input: JSON.stringify(request),
  })
  const outcome: TurnOutcome = { report: null, status: null, error: null }
  let controlDir: string | null = null
  let stdout = ''
  let stderr = ''
  // Only the session's record is waited for at the end. A question still open when the
  // bridge has ended is moot: the bridge answered it no as it stopped.
  const saving: Promise<unknown>[] = []

  const answer = async (id: number, ask: ApprovalRequest) => {
    const allow = await hooks.onApproval(ask).catch(() => false)
    if (controlDir !== null) await $.fs.write(`${controlDir}/answer-${id}.json`, JSON.stringify({ allow }))
  }

  const handle = (line: string) => {
    if (line.trim() === '') return
    let event: BridgeEvent
    try {
      event = JSON.parse(line) as BridgeEvent
    } catch {
      return
    }
    switch (event.type) {
      case 'ready':
        controlDir = event.controlDir
        return
      case 'event': {
        const inner = event.event
        if (inner.type === 'session') {
          saving.push(hooks.onSession(inner.sessionId, inner.model, inner.effort ?? null).catch(() => {}))
          return
        }
        const activity = activityOf(inner)
        if (activity !== null) hooks.onActivity(activity)
        return
      }
      case 'approval':
        void answer(event.id, event.request).catch(() => {})
        return
      case 'result':
        outcome.report = event.report
        outcome.status = event.result.status
        return
      case 'error':
        outcome.error = event.message
        return
    }
  }

  try {
    for await (const piece of stream) {
      if (piece.stream === 'stderr') {
        stderr = (stderr + piece.text).slice(-4000)
        continue
      }
      stdout += piece.text
      for (let end = stdout.indexOf('\n'); end !== -1; end = stdout.indexOf('\n')) {
        handle(stdout.slice(0, end))
        stdout = stdout.slice(end + 1)
      }
    }
    handle(stdout)
  } catch (error) {
    outcome.error ??= `the bridge could not run: ${String(error)}`
  }
  await Promise.all(saving)
  if (outcome.report === null && outcome.error === null) {
    const tail = stderr.trim().split('\n').slice(-6).join('\n')
    outcome.error = `the bridge ended without a result${tail ? `:\n${tail}` : '.'}`
  }
  return outcome
}
