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
  /** "disabled" to run without the option's sandbox, "enabled" to add one; null for the option's own. */
  sandbox: 'enabled' | 'disabled' | null
  approvals: Approvals
  mode: string
  model: string | null
  effort: string | null
  /** The backend session to continue. If it cannot be continued the turn fails: no new one is started. */
  resumeSessionId: string | null
  /** The bridge stops a turn that nothing has followed for this long (TurnControl.follow). */
  leaseSec: number
}

export type Action = { kind: string; title: string; status?: string; exitCode?: number | null; permission?: string }

/** An answer the user is offered; one that stops also ends the turn. */
export type Choice = { id: string; label: string; allow: boolean; stop?: boolean }

export type ApprovalRequest = {
  kind: string
  title: string
  cwd: string | null
  reason: string | null
  /** The agent's own answers, declining ones first, at most four. */
  choices: Choice[]
}

/** One of the agent's answers, or the user's own words, which decline and are passed on. */
export type ApprovalAnswer = { choice: string } | { text: string } | null

type BackendEvent =
  | { type: 'session'; sessionId: string; model: string | null; effort?: string | null }
  | { type: 'action'; action: Action; output?: string }
  | { type: 'progress'; text: string }
  | { type: 'note'; text: string }

type RunResult = { status: 'completed' | 'cancelled' | 'failed'; sessionId: string | null; model: string | null }

type BridgeEvent =
  | { type: 'ready'; controlDir: string; token: string; jobId: string | null }
  | { type: 'event'; event: BackendEvent }
  | { type: 'approval'; id: number; request: ApprovalRequest }
  | { type: 'result'; result: RunResult; report: string }
  | { type: 'error'; message: string }

/** What the module can do to a turn while the bridge runs it. */
export type TurnControl = {
  /** The id of the turn's record, which `bridge.mjs wait` follows; null where no record could be kept. */
  jobId: string | null
  /** Says that the turn is still being followed, which keeps its lease. */
  follow: () => Promise<void>
  /** Stops the turn: the bridge interrupts the backend, records how far it got, and ends. */
  cancel: () => Promise<void>
}

export type TurnHooks = {
  /** The bridge is up: how to follow and stop its turn. */
  onReady: (control: TurnControl) => void
  /** The backend opened or resumed its session: keep the id to continue it next turn. */
  onSession: (sessionId: string, model: string | null, effort: string | null) => Promise<void>
  /** What the delegate did last, in one line. */
  onActivity: (line: string) => void
  /** Resolves to the answer for the agent. */
  onApproval: (request: ApprovalRequest) => Promise<ApprovalAnswer>
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
    // Names the plugin's data folder, where the bridge keeps its records of turns.
    env: await $.process.hookEnv().catch(() => ({})),
    input: JSON.stringify(request),
  })
  const outcome: TurnOutcome = { report: null, status: null, error: null }
  let controlDir: string | null = null
  // Every file written to the control directory carries the turn's token, which the bridge
  // sent on stdout only: a delegate that can write there cannot answer for the user.
  let token: string | null = null
  // Once the bridge has ended, an answer that comes late is not written: its directory is gone.
  let ended = false
  let stdout = ''
  let stderr = ''
  // Only the session's record is waited for at the end. A question still open when the
  // bridge has ended is moot: the bridge answered it no as it stopped.
  const saving: Promise<unknown>[] = []

  const answer = async (id: number, ask: ApprovalRequest) => {
    const picked = await hooks.onApproval(ask).catch(() => null)
    if (ended || controlDir === null) return
    await $.fs.write(`${controlDir}/answer-${id}.json`, JSON.stringify({ ...(picked ?? {}), token }))
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
      case 'ready': {
        const dir = event.controlDir
        const sign = event.token
        controlDir = dir
        token = sign
        const write = async (name: string) => {
          if (!ended) await $.fs.write(`${dir}/${name}`, JSON.stringify({ token: sign, at: Date.now() })).catch(() => {})
        }
        hooks.onReady({ jobId: event.jobId, follow: () => write('alive'), cancel: () => write('cancel') })
        return
      }
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
  ended = true
  await Promise.all(saving)
  if (outcome.report === null && outcome.error === null) {
    const tail = stderr.trim().split('\n').slice(-6).join('\n')
    outcome.error = `the bridge ended without a result${tail ? `:\n${tail}` : '.'}`
  }
  return outcome
}
