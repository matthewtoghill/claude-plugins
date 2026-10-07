import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, UiPressArgument } from 'claude-code'

import type { Change, Mode, Prompt, Step } from '../types'
import { clip, fileDiff, patch, side, sides, unapply } from './diff'
import type { FileDiff } from './diff'

const PANE = 'session-replay'
// ponytail: whole-file snapshots kept in session state; files past this are skipped. Store diffs only if memory bites.
const MAX_FILE = 512 * 1024

const prompts = atom({ plugin: 'session-replay', key: 'prompts' } as const, [] as Prompt[])
const changes = atom({ plugin: 'session-replay', key: 'changes' } as const, [] as Change[])
const sel = atom({ plugin: 'session-replay', key: 'sel' } as const, null as Step | null)
const mode = atom({ plugin: 'session-replay', key: 'mode' } as const, 'stage' as Mode)
const playing = atom({ plugin: 'session-replay', key: 'playing' } as const, false)
const confirming = atom({ plugin: 'session-replay', key: 'confirming' } as const, false)

// Timers die with the module on reload; `playing` is reset in session.start to match.
let timer: Timer | undefined

const base = (p: string) => p.split(/[\\/]/).pop() ?? p
const short = (t: string, n = 60) => (t.length > n ? t.slice(0, n - 1) + '…' : t).replace(/\s+/g, ' ')

async function record($: EngineInterface, id: string | undefined, tool: string, file: string, before: string | null, after: string | null) {
  if (before === after) return
  if ((before?.length ?? 0) > MAX_FILE || (after?.length ?? 0) > MAX_FILE) return
  const list = await read($, prompts)
  if (!list.length) await update($, prompts, l => (l.length ? l : [{ text: '(before first prompt)' }]))
  const prompt = Math.max(0, (await read($, prompts)).length - 1)
  await update($, changes, l => [...l, { id, prompt, tool, file, before, after }])
}

async function copy($: EngineInterface, text: string, what: string, surface: UiPressArgument['surface']) {
  const r = await $.ui.copy({ text, surface })
  $.ui.toast(r.isCopied ? `Copied ${what}.` : `Copy failed: ${r.reason}`)
}

async function readOrNull($: EngineInterface, file: string): Promise<string | null> {
  return $.fs.read(file).catch(() => null)
}

/** Prompts that changed something, each followed by its changes: the order Prev/Next/Play walk. */
function stepsOf(ps: Prompt[], cs: Change[]): Step[] {
  return ps.flatMap((_, p) => {
    const mine = cs.flatMap((c, i) => (c.prompt === p ? [{ kind: 'edit' as const, i }] : []))
    return mine.length ? [{ kind: 'prompt' as const, i: p }, ...mine] : []
  })
}

/** Change-index range a step covers: [lo, hi]; cumulative views use [0, hi]. */
function rangeOf(cs: Change[], s: Step): [number, number] {
  if (s.kind === 'edit') return [s.i, s.i]
  const idx = cs.flatMap((c, i) => (c.prompt === s.i ? [i] : []))
  return [idx[0], idx[idx.length - 1]]
}

function diffsOf(cs: Change[], lo: number, hi: number): FileDiff[] {
  const span = new Map<string, { before: string | null; after: string | null }>()
  for (const c of cs.slice(lo, hi + 1)) {
    const had = span.get(c.file)
    span.set(c.file, { before: had ? had.before : c.before, after: c.after })
  }
  return [...span].flatMap(([file, x]) => fileDiff(file, x.before, x.after) ?? [])
}

function stepLabel(ps: Prompt[], cs: Change[], s: Step): string {
  if (s.kind === 'prompt') return `#${s.i + 1} "${short(ps[s.i].text)}"`
  const c = cs[s.i]
  const n = cs.filter((x, i) => x.prompt === c.prompt && i <= s.i).length
  return `#${c.prompt + 1}.${n} ${c.tool} ${base(c.file)}`
}

async function step($: EngineInterface, by: number) {
  const steps = stepsOf(await read($, prompts), await read($, changes))
  if (!steps.length) return
  const cur = (await read($, sel)) ?? steps[steps.length - 1]
  const k = steps.findIndex(x => x.kind === cur.kind && x.i === cur.i)
  const to = Math.min(steps.length - 1, Math.max(0, k + by))
  await update($, sel, () => steps[to])
  if (by > 0 && to === steps.length - 1) await stop($)
}

async function play($: EngineInterface) {
  const steps = stepsOf(await read($, prompts), await read($, changes))
  const cur = await read($, sel)
  // Playing from the end restarts at the beginning.
  if (!cur || (cur.kind === steps.at(-1)?.kind && cur.i === steps.at(-1)?.i)) await update($, sel, () => steps[0] ?? null)
  await update($, playing, () => true)
  timer?.cancel()
  timer = $.clock.every(1500, () => void step($, 1))
}

async function stop($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  await update($, playing, () => false)
}

/** Puts every file the session touched back as it stood at the end of change `hi`; recorded as its own stage. */
async function restore($: EngineInterface, hi: number, label: string) {
  const cs = await read($, changes)
  const files = [...new Set(cs.map(c => c.file))]
  const skipped: string[] = []
  const done: [string, string | null, string][] = []
  for (const file of files) {
    const upTo = cs.slice(0, hi + 1).filter(c => c.file === file)
    const target = upTo.length ? upTo[upTo.length - 1].after : cs.find(c => c.file === file)!.before
    const now = await readOrNull($, file)
    if (now === target) continue
    // $.fs has no delete: a file that did not exist at that stage is left for the person.
    if (target === null) { skipped.push(base(file)); continue }
    await $.fs.write(file, target)
    done.push([file, now, target])
  }
  await update($, confirming, () => false)
  if (!done.length && !skipped.length) return $.ui.toast('Already matches that stage.')
  await update($, prompts, l => [...l, { text: `⟲ restored to ${label}` }])
  for (const [file, now, target] of done) await record($, undefined, 'Restore', file, now, target)
  await update($, sel, () => null)
  $.ui.toast(
    `Restored ${done.length} file(s) to ${label}.` +
      (skipped.length ? ` Not deleted (created later): ${skipped.join(', ')}` : ''),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'replay', description: 'Step through and replay the file changes of this session' })
    await update($, playing, () => false)
    return next(e)
  })

  on('command.run', { command: 'replay' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Replay' })
    return { text: 'Replay pane opened.' }
  })

  // Main-loop turns only (subagents raise no turn.start); a continuation ("") stays in the current prompt.
  on('turn.start', async ($, e, next) => {
    if (e.text) await update($, prompts, l => [...l, { text: e.text }])
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError || r.result.staged || r.result.originalFile === null) return r
    await record($, e.tool_use_id, 'Edit', r.result.filePath, r.result.originalFile, await readOrNull($, r.result.filePath))
    return r
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError || r.result.staged) return r
    if (r.result.type === 'update' && r.result.originalFile === null) return r // too large to have been kept
    await record($, e.tool_use_id, 'Write', r.result.filePath, r.result.originalFile, r.result.content)
    return r
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError || r.result.error) return r
    await record($, e.tool_use_id, 'NotebookEdit', r.result.notebook_path, r.result.original_file, r.result.updated_file)
    return r
  })

  // ponytail: PowerShell results carry no edit diff, so its file changes are not seen; snapshot git status around it if needed.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError) return r
    for (const f of r.result.bashEditDiff?.files ?? []) {
      const after = f.deleted ? null : await readOrNull($, f.filePath)
      const before = f.created ? null : after === null ? null : unapply(after, f.hunks)
      await record($, e.tool_use_id, 'Bash', f.filePath, before, after)
    }
    return r
  })

  // Each transcript row whose call changed a file keeps the engine's drawing and gains a button onto that change.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.isRunning) return next(e)
    const i = (await read($, changes)).findIndex(c => c.id === e.props.tool_use_id)
    if (i < 0) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const row = await next(e)
    return (
      <Box flexDirection="column">
        {row}
        <Button
          key={`replay-${e.props.tool_use_id}`}
          plain
          dimColor
          onPress={() => void update($, sel, () => ({ kind: 'edit', i })).then(() => $.ui.open({ id: PANE, title: 'Replay' }))}
        >
          ↺ Replay this change
        </Button>
      </Box>
    )
  })

  // A slim row above the prompt once the session has changed files; it yields to a survey.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cs = await read($, changes)
    if (e.props.hasSurvey || !cs.length) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const files = new Set(cs.map(c => c.file)).size
    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>
          {cs.length} change(s) to {files} file(s) this session
        </Text>
        <Button key="open-replay" onPress={() => void $.ui.open({ id: PANE, title: 'Replay' })}>
          ↺ Open replay
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const ps = await read($, prompts)
    const cs = await read($, changes)
    const m = await read($, mode)
    const isPlaying = await read($, playing)
    const isConfirming = await read($, confirming)
    const steps = stepsOf(ps, cs)

    if (!steps.length)
      return <Text dimColor>No file changes yet. Edits made with Edit, Write, NotebookEdit or Bash appear here, grouped by prompt.</Text>

    const cur = (await read($, sel)) ?? steps[steps.length - 1]
    const k = Math.max(0, steps.findIndex(x => x.kind === cur.kind && x.i === cur.i))
    const [lo, hi] = rangeOf(cs, cur)
    const diffs = m === 'stage' ? diffsOf(cs, lo, hi) : diffsOf(cs, 0, hi)
    const label = stepLabel(ps, cs, cur)
    const openPrompt = cur.kind === 'prompt' ? cur.i : cs[cur.i].prompt
    const add = diffs.reduce((n, d) => n + d.add, 0)
    const del = diffs.reduce((n, d) => n + d.del, 0)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="prev" hotkey="p" onPress={() => void step($, -1)}>◀ Prev</Button>
          <Button key="next" hotkey="n" onPress={() => void step($, 1)}>Next ▶</Button>
          <Button key="play" hotkey="a" variant={isPlaying ? 'primary' : undefined} onPress={() => void (isPlaying ? stop($) : play($))}>
            {isPlaying ? '❚❚ Pause' : '▶ Play'}
          </Button>
          <Button key="stage" hotkey="s" variant={m === 'stage' ? 'primary' : undefined} onPress={() => void update($, mode, () => 'stage')}>
            This stage
          </Button>
          <Button key="cumulative" hotkey="c" variant={m === 'cumulative' ? 'primary' : undefined} onPress={() => void update($, mode, () => 'cumulative')}>
            Cumulative
          </Button>
          <Button
            key="copy"
            hotkey="y"
            onPress={press => void copy($, patch(diffs), `patch for ${diffs.length} file(s)`, press.surface)}
          >
            Copy patch
          </Button>
          <Button key="copy-old" hotkey="o" onPress={press => void copy($, sides(diffs, 'old'), `old code for ${diffs.length} file(s)`, press.surface)}>
            Copy old
          </Button>
          <Button key="copy-new" hotkey="w" onPress={press => void copy($, sides(diffs, 'new'), `new code for ${diffs.length} file(s)`, press.surface)}>
            Copy new
          </Button>
          <Button key="restore" hotkey="r" onPress={() => void update($, confirming, () => true)}>
            Restore…
          </Button>
        </Box>

        {isConfirming && (
          <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text>Overwrite every file this session touched with its content as of {label}?</Text>
            <Box flexDirection="row" gap={1}>
              <Button key="restore-yes" variant="primary" onPress={() => void restore($, hi, label)}>Yes, restore</Button>
              <Button key="restore-no" onPress={() => void update($, confirming, () => false)}>Cancel</Button>
            </Box>
          </Box>
        )}

        <Box flexDirection="column">
          {steps
            .filter(s => s.kind === 'prompt' || cs[s.i].prompt === openPrompt)
            .map(s => {
              const isSel = s.kind === cur.kind && s.i === cur.i
              const files = s.kind === 'prompt' ? new Set(cs.filter(c => c.prompt === s.i).map(c => c.file)).size : 0
              const text =
                s.kind === 'prompt'
                  ? `${s.i === openPrompt ? '▾' : '▸'} ${stepLabel(ps, cs, s)}  ${files} file(s)`
                  : `    ${stepLabel(ps, cs, s)}`
              return (
                <Button key={`${s.kind}-${s.i}`} plain dimColor={!isSel} onPress={() => void update($, sel, () => s)}>
                  {(isSel ? '› ' : '  ') + text}
                </Button>
              )
            })}
        </Box>

        <Text bold>
          {k + 1}/{steps.length} {m === 'stage' ? 'This stage' : 'Session start → here'}: {label}{'  '}
          <Text color="green">+{add}</Text> <Text color="red">−{del}</Text>
        </Text>

        {diffs.length === 0 && <Text dimColor>No net change.</Text>}
        {diffs.map(d => {
          const { source, isCut } = clip(d.hunks)
          return (
            <Box flexDirection="column">
              <Text>
                {d.file} <Text color="green">+{d.add}</Text> <Text color="red">−{d.del}</Text>
              </Text>
              <Code format="diff" source={source} path={d.file} />
              {isCut && <Text dimColor>… diff cut for display; Copy patch / old / new have all of it.</Text>}
              <Box flexDirection="row" gap={1}>
                <Button key={`old-${d.file}`} plain dimColor onPress={press => void copy($, side(d, 'old'), `old code of ${base(d.file)}`, press.surface)}>
                  Copy old
                </Button>
                <Button key={`new-${d.file}`} plain dimColor onPress={press => void copy($, side(d, 'new'), `new code of ${base(d.file)}`, press.surface)}>
                  Copy new
                </Button>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
