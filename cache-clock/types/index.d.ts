/** One prompt cache: the main thread's or one subagent's, on one model. */
export type Cache = {
  /** `Main`, or the subagent's type. */
  label: string
  model: string
  isSubagent: boolean
  ttlMs: number
  /** When the last request that used it started, in `$.clock.now()` ms; the TTL runs from here. */
  usedAt: number
  /** The prefix the cache holds after the last request: its read and written tokens. */
  cached: number
  /** What the next request re-sends: the last response's input, cache and output tokens. */
  context: number
  /** Input tokens read from the cache, and all input tokens, summed over every request. */
  read: number
  input: number
  /** Requests that read less than the request before had cached. */
  misses: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-clock': {
      /** By `<agentId or main>:<model>`. */
      caches: Record<string, Cache>
      /** Subagent types by agent id, from SubagentStart. */
      labels: Record<string, string>
      /** The TTL a model switch reported; null until one does. */
      ttlMs: number | null
      /** Closed with the band's x; the next response shows it again. */
      isHidden: boolean
      /** The main cache is re-read before it expires until `until` (`$.clock.now()` ms); `option` is the dropdown's pick. */
      keepWarm: { option: string; until: number } | null
    }
  }
}
