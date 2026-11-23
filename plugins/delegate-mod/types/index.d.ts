/** What the row of the Agent or SendMessage call that started a delegate turn shows under it. */
export type Progress = {
  /** "Codex Agent (gpt-6.2-astra xHigh)", or the bare name until the model is known. */
  agent: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  /** What the delegate did last, in one line; while waiting on the user, what it asked. */
  line: string
  startedAt: number
  endedAt: number | null
}

/** What the latest spawn of a delegate said: kept here, so that a reload of the plugin keeps it. */
export type SpawnRecord = {
  backend: 'codex' | 'agy'
  /** The conversation's permission mode at the spawn; null where Claude Code gave none. */
  mode: string | null
  /** The tool_use_id of the Agent or SendMessage call that spawned it. */
  rowId: string
}

/** A delegate turn the plugin took on, so that it runs once whatever reloads come between its steps. */
export type TurnRecord = {
  /** The id of the hand-back call that carried the report, if it went that way. */
  handBackId: string | null
  /** The report, once there is one. */
  report: string | null
}

declare module 'claude-code' {
  interface PluginState {
    delegate: {
      /** One per Agent or SendMessage call, keyed by its tool_use_id. */
      progress: StateFamily<Progress>
      /** One per delegate, keyed by its agent id. */
      spawn: StateFamily<SpawnRecord>
      /** One per delegate turn, keyed by its turn id. */
      turn: StateFamily<TurnRecord>
    }
  }
}
