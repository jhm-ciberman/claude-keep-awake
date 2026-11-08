/**
 * A promise to keep the machine awake until a time, or until it is ended when `until` is absent.
 */
export type KeepAwakeLease = {
  /**
   * When the lease ends, in milliseconds since the epoch; absent for a lease without an end.
   */
  until?: number
  /**
   * What the lease is for, as the status line shows it.
   */
  reason?: string
}

/**
 * What keeps the machine awake past a turn, kept so a reload of the mod does not lose it.
 */
export type KeepAwakeLeases = {
  /**
   * The main conversation's lease, taken with the keep_awake tool.
   */
  claude?: KeepAwakeLease
  /**
   * The leases subagents took with the keep_awake tool, by agent id.
   */
  agents: Record<string, KeepAwakeLease>
  /**
   * The user's lease, taken with /awake.
   */
  person?: KeepAwakeLease
  /**
   * When the grace time after the last turn ends, in milliseconds since the epoch.
   */
  graceUntil: number
}

declare module 'claude-code' {
  interface PluginState {
    'keep-awake': { leases: KeepAwakeLeases }
  }
}
