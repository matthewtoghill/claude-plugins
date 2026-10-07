import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run, Runner, Watch } from '../types'

const EMPTY: Watch = { changed: [], run: null, runner: null, isHidden: false }
const watch = atom({ plugin: 'test-watch', key: 'watch' } as const, EMPTY)

// ponytail: only the tail is kept; test runners print their failure summary last.
const MAX_OUTPUT = 12000
const TIMEOUT_MS = 10 * 60 * 1000

/** The project's test runner, read off the files in the working directory. */
async function detect($: EngineInterface): Promise<Runner | null> {
  const names = new Set((await $.fs.list().catch(() => [])).map(f => f.name))
  if (names.has('package.json')) {
    const pkg = JSON.parse(await $.fs.read('package.json').catch(() => '{}'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps.vitest) return { all: 'npx vitest run', related: 'npx vitest related --run' }
    if (deps.jest) return { all: 'npx jest', related: 'npx jest --findRelatedTests' }
    const script: unknown = pkg.scripts?.test
    if (typeof script === 'string' && !script.includes('no test specified')) return { all: 'npm test' }
  }
  if (names.has('Cargo.toml')) return { all: 'cargo test' }
  if (names.has('go.mod')) return { all: 'go test ./...' }
  if ([...names].some(n => /\.(sln|slnx|csproj|fsproj)$/.test(n))) return { all: 'dotnet test' }
  if (['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini'].some(n => names.has(n))) return { all: 'python -m pytest' }
  return null
}

// ponytail: a path holding a double quote breaks the shell line; no repo seen has one.
const quote = (path: string) => (/\s/.test(path) ? `"${path}"` : path)

/** The command line for a run: the related tests of the changed files where the runner can, the whole suite otherwise. */
function commandFor(runner: Runner, changed: string[], isAll: boolean): string {
  return !isAll && runner.related && changed.length > 0 ? `${runner.related} ${changed.map(quote).join(' ')}` : runner.all
}

/** The text the Fix button adds to the draft. */
function fixPrompt(run: Run): string {
  return `The tests failed (\`${run.command}\`, exit ${run.exitCode}). Fix the failures. Output:\n\n\`\`\`\`\n${run.output.trim()}\n\`\`\`\``
}

/** The `command` option, set as the module loads; empty means detect. */
let override = ''

async function runnerOf($: EngineInterface): Promise<Runner | null> {
  return override ? { all: override } : detect($)
}

async function changed($: EngineInterface, paths: string[]) {
  if (paths.length === 0) return
  await update($, watch, w => ({ ...w, isHidden: false, changed: [...new Set([...w.changed, ...paths])] }))
}

async function runTests($: EngineInterface, isAll: boolean) {
  const before = await read($, watch)
  if (before.run?.status === 'running') return
  const runner = await runnerOf($)
  if (!runner) {
    await update($, watch, w => ({ ...w, runner: null }))
    return
  }
  const command = commandFor(runner, before.changed, isAll)
  const running: Run = { command, status: 'running', output: '' }
  await update($, watch, w => ({ ...w, runner, changed: [], run: running }))

  const cwd = await $.session.cwd()
  const isWindows = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd)
  const argv = isWindows ? ['cmd', '/d', '/s', '/c', `${command} 2>&1`] : ['sh', '-c', `${command} 2>&1`]
  const startedAt = await $.clock.now()
  const done = await $.process.run(argv, { timeoutMs: TIMEOUT_MS, env: { CI: '1', FORCE_COLOR: '0' } }).then(
    p => ({ exitCode: p.exitCode, output: p.stdout + p.stderr }),
    (err: unknown) => ({ exitCode: -1, output: `Could not run \`${command}\`: ${err instanceof Error ? err.message : String(err)}` }),
  )
  const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
  const run: Run = {
    command,
    status: done.exitCode === 0 ? 'passed' : 'failed',
    exitCode: done.exitCode,
    seconds,
    output: done.output.slice(-MAX_OUTPUT),
  }
  await update($, watch, w => ({ ...w, run }))
}

/** Off the press's dispatch, so the band redraws as running while the tests go. */
function start($: EngineInterface, isAll: boolean) {
  return $.clock.after(0, () => runTests($, isAll))
}

async function fix($: EngineInterface) {
  const { run } = await read($, watch)
  if (run?.status !== 'failed') return
  const { text } = await $.prompt.read()
  const hasDraft = /\S/.test(text)
  await $.prompt.fill({ text: (hasDraft ? '\n\n' : '') + fixPrompt(run), mode: hasDraft ? 'append' : 'replace' })
}

export const register: Register = (on, options) => {
  override = typeof options.command === 'string' ? options.command.trim() : ''

  on('session.start', async ($, e, next) => {
    const runner = await runnerOf($)
    // A reload drops the process a run was waiting on; its result never arrives.
    await update($, watch, w => ({ ...w, runner, run: w.run?.status === 'running' ? null : w.run }))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await update($, watch, () => EMPTY)
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError && !r.result.staged) await changed($, [r.result.filePath])
    return r
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError && !r.result.staged) await changed($, [r.result.filePath])
    return r
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError && !r.result.error) await changed($, [r.result.notebook_path])
    return r
  })

  // ponytail: PowerShell results carry no edit diff, so files it changes are not counted.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError) await changed($, (r.result.bashEditDiff?.files ?? []).map(f => f.filePath))
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const w = await read($, watch)
    const isRunning = w.run?.status === 'running'
    const isQuiet = w.isHidden || (w.changed.length === 0 && !w.run) || e.props.hasSurvey || e.props.view.agentId
    if (isQuiet || (e.props.isWorking && !isRunning)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const plain = e.surface === 'terminal' || undefined
    const files = w.changed.length === 1 ? '1 file changed' : `${w.changed.length} files changed`
    const run = w.run
    const result =
      run?.status === 'passed' ? `✓ Tests passed in ${run.seconds}s`
      : run?.status === 'failed' ? `✗ Tests failed (exit ${run.exitCode}) in ${run.seconds}s`
      : ''
    const status = isRunning
      ? `Running ${run?.command}…`
      : !w.runner ? 'No test command found; set one in the test-watch plugin options'
      : [result, w.changed.length ? (run ? `${files} since` : files) : ''].filter(Boolean).join(', ')
    const canRelated = !!w.runner?.related && w.changed.length > 0

    // Draw beside whatever the plugins below draw, so other bands still show.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection={plain ? 'column' : 'row'} flexWrap="wrap" columnGap={1}>
          <Text color={run?.status === 'failed' && !isRunning ? 'red' : undefined} dimColor={run?.status !== 'failed' || isRunning}>
            {status}
          </Text>
          {!isRunning && w.runner && (
            <Button key="run" hotkey="r" plain={plain} variant="primary" label={canRelated ? 'Run affected tests' : 'Run tests'} onPress={() => start($, false)} />
          )}
          {!isRunning && canRelated && <Button key="run-all" hotkey="a" plain={plain} label="Run all" onPress={() => start($, true)} />}
          {!isRunning && run?.status === 'failed' && <Button key="fix" hotkey="f" plain={plain} label="Fix" onPress={() => fix($)} />}
          {!isRunning && (
            <Button key="tests-dismiss" hotkey="x" plain={plain} role="dismiss" dimColor label="Dismiss" onPress={() => update($, watch, v => ({ ...v, isHidden: true }))} />
          )}
        </Box>
        {below}
      </Box>
    )
  })
}
