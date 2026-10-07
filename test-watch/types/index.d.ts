/** How to run the tests: the whole suite, and a prefix that takes the changed files when the runner supports it. */
export type Runner = { all: string; related?: string }

export type Run = {
  command: string
  status: 'running' | 'passed' | 'failed'
  exitCode?: number
  seconds?: number
  /** The tail of stdout and stderr combined. */
  output: string
}

/** Files changed since the last run started, the last run, the detected runner, and whether the band was dismissed. */
export type Watch = { changed: string[]; run: Run | null; runner: Runner | null; isHidden: boolean }

declare module 'claude-code' {
  interface PluginState {
    'test-watch': { watch: Watch }
  }
}
