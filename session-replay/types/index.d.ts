/** A prompt the person sent; every change made while its turn ran belongs to it. */
export type Prompt = { text: string }

/** One file change. `null` content means the file did not exist (before) or was deleted (after). */
export type Change = {
  /** The tool call that made it (absent for a restore), so its transcript row can open the pane on it. */
  id?: string
  prompt: number
  tool: string
  file: string
  before: string | null
  after: string | null
}

/** A position in the replay: a whole prompt, or one change (index into `changes`). */
export type Step = { kind: 'prompt' | 'edit'; i: number }

export type Mode = 'stage' | 'cumulative'

declare module 'claude-code' {
  interface PluginState {
    'session-replay': {
      prompts: Prompt[]
      changes: Change[]
      sel: Step | null
      mode: Mode
      playing: boolean
      confirming: boolean
    }
  }
}
