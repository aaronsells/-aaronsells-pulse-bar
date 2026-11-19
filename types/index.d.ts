/** What Claude is doing right now. */
export type Live = {
  phase: 'idle' | 'thinking' | 'tool'
  /** Tools in flight, in the order they started (parallel calls stack). */
  active: readonly string[]
  /** When the current main-loop turn began, ms since epoch. */
  turnStartedAt: number | null
  /** When the oldest in-flight tool began. */
  toolStartedAt: number | null
  /** Seconds the last finished turn took. */
  lastTurnSeconds: number | null
}

/** Running totals for this session. */
export type Stats = {
  prompts: number
  toolCalls: number
  failures: number
  byTool: Readonly<Record<string, number>>
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'pulse-bar': {
      live: Live
      stats: Stats
      /** Timestamps of recent tool calls, inside the sparkline window. */
      recent: readonly number[]
      /** The clock as of the last tick; drawing reads it so elapsed times move. */
      now: number
      isExpanded: boolean
    }
  }
}
