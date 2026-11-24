// How the plugin answers a model request of a delegate's loop in place of the model.
//
// A subagent hands its report to its caller in one of two ways. Where Claude Code offers it
// the SubagentHandback tool (in auto mode), by calling that tool with { message }, which
// ends its run; elsewhere its last words are its report. register.tsx picks the way for
// each run; should a hand-back call come back as an error all the same, the step after it
// says the report as words.
//
// A turn takes many steps. While the backend works, each step is a row: a call of the Bash
// tool that this plugin writes and answers itself, and that runs no command. Claude Code
// shows such a call by its description, so the rows read as what the delegate did, one
// after the other, and no step is long enough to be taken for a stalled agent.

import type { EngineInterface, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

type Step = AsyncGenerator<TurnStepChunk, TurnStepResult>

const HANDBACK = 'SubagentHandback'

function newToolUseId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `toolu_dlg${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`
}

/** The report as a call of the hand-back tool. Returns the call's id, to check its result. */
export async function* handBack(e: TurnStepInput, report: string, onId: (id: string) => void): Step {
  const id = newToolUseId()
  onId(id)
  const input = { message: report }
  yield { kind: 'tool', index: 0, id, name: HANDBACK }
  yield { kind: 'input', index: 0, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: HANDBACK, input }], stopReason: 'tool_use', usage: null }
}

/** The report as the turn's last words. */
export async function* say(e: TurnStepInput, text: string): Step {
  yield { kind: 'text', index: 0, text }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
}

/** What a row's Bash call carries as its command: a shell no-op, should anything ever run it. */
const ROW_COMMAND = ': progress of the delegate - this row runs no command'

/** A stretch of the delegate's work as a row, titled with what it did last. Returns the call's id through `onId`. */
export async function* row(e: TurnStepInput, title: string, onId: (id: string) => void): Step {
  const id = newToolUseId()
  onId(id)
  const input = { command: ROW_COMMAND, description: title }
  yield { kind: 'tool', index: 0, id, name: 'Bash' }
  yield { kind: 'input', index: 0, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Bash', input }], stopReason: 'tool_use', usage: null }
}

/** Nothing more to say: the report went through the hand-back tool. */
export async function* endTurn(e: TurnStepInput): Step {
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
}

/**
 * Whether the hand-back call `id` came back as an error (no such tool, or refused). Where
 * the conversation cannot be read, it is taken as failed: the report is then said once
 * more, rather than lost.
 */
export async function handBackFailed($: EngineInterface, agentId: string, id: string): Promise<boolean> {
  const read = await $.session.messages({ agentId, last: 4 })
  if ('deny' in read) return true
  for (const message of read) {
    for (const result of message.toolResults ?? []) {
      if (result.tool_use_id === id) return result.isError
    }
  }
  return false
}

export type Said = { text: string; uuid: string | null }

/** The newest thing said to the delegate: the task, or a follow-up sent with SendMessage. */
export async function latestMessage($: EngineInterface, agentId: string): Promise<Said> {
  const read = await $.session.messages({ agentId, last: 6 })
  if ('deny' in read) return { text: '', uuid: null }
  for (let i = read.length - 1; i >= 0; i--) {
    const message = read[i]
    // A row's result is a user message too, and is no word to the delegate.
    if (message !== undefined && message.role === 'user' && message.text.trim() !== '' && !message.toolResults?.length) {
      return { text: message.text, uuid: message.uuid ?? null }
    }
  }
  return { text: '', uuid: null }
}
