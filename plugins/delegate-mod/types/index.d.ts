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

declare module 'claude-code' {
  interface PluginState {
    delegate: {
      /** One per Agent or SendMessage call, keyed by its tool_use_id. */
      progress: StateFamily<Progress>
    }
  }
}
