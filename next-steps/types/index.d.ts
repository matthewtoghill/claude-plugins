export type Suggestion = { label: string; prompt: string }

/** The suggestions shown, which are toggled on, and the text the mod last put at the end of the draft. */
export type Band = { suggestions: Suggestion[]; selected: number[]; drafted: string }

declare module 'claude-code' {
  interface PluginState {
    'next-steps': { band: Band }
  }
}
