// The values the delegate mod keeps in `$.state`. They outlive a reload of the mod,
// so a shape that changes gets a new tag in hooks/register.tsx.

/** What a delegate is doing now, drawn under its tool call's row while the call runs. */
export type DelegateProgress = {
  /** The job the call is following. */
  job: string
  /** The agent and its model, as in `Codex Agent (gpt-6.2-astra xHigh)`. */
  agent: string
  /** How long the job had run when this was read. */
  elapsedMs: number
  /** The last thing the delegate did, in one line; null until it has done anything. */
  doing: string | null
}

/** A job started with `background: true`, followed until its result has been handed over. */
export type DelegateBackgroundJob = {
  job: string
  agent: string
  /** Set once the result has been handed over, by the follower or by a wait call. */
  isDelivered: boolean
}

declare module 'claude-code' {
  interface PluginState {
    delegate: {
      progress: StateFamily<DelegateProgress | null>
      background: Shaped<DelegateBackgroundJob[]>
    }
  }
}
