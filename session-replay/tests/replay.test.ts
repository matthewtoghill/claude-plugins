import { expect, mock, test } from 'claude-code/testing'

import { fileDiff, side, unapply } from '../hooks/diff'

const PANE_PROPS = {
  title: 'Replay',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test('diff helpers: hunk counts and Bash un-apply round trip', async () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\n'
  const after = 'a\nb\nC\nd\ne\nf\ng\nh\ni\n'
  const d = fileDiff('x.txt', before, after)!
  expect(d.add).toBe(2)
  expect(d.del).toBe(1)
  expect(d.hunks.length).toBe(1)
  const hs = d.hunks.map(h => ({
    newStart: h.b + 1,
    newLines: h.lines.filter(l => l[0] !== '-').length,
    lines: h.lines,
  }))
  expect(unapply(after, hs)).toBe(before)
  expect(fileDiff('x', 'same', 'same')).toBe(undefined)
  expect(fileDiff('new.txt', null, 'one\ntwo\n')!.add).toBe(2)
  expect(side(d, 'old')).toBe('a\nb\nc\nd\ne\nf\ng\nh\n')
  expect(side(d, 'new')).toBe(after)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`records edits per prompt, toggles cumulative, restores (${surface})`, async ($, on) => {
    const disk = new Map<string, string>()
    // The engine resolves paths (C:\p\a.ts on Windows); key the fake disk by the POSIX spelling.
    const k = (p: string) => p.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
    on('fs.read', ($, e) => {
      const t = disk.get(k(e.path))
      if (t === undefined) throw new Error('ENOENT')
      return { value: t } as never
    })
    on('fs.write', ($, e) => (disk.set(k(e.path), e.text), { value: undefined }) as never)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))

    const write = (file: string, content: string) => {
      const old = disk.get(file) ?? null
      disk.set(file, content)
      return {
        result: {
          type: old === null ? 'create' : 'update',
          filePath: file,
          content,
          structuredPatch: [],
          originalFile: old,
        },
      }
    }
    on('tool.call', { tool: 'Write' }, ($, e) => write(e.file_path, e.content) as never)
    on('tool.call', { tool: 'Edit' }, ($, e) => {
      const old = disk.get(e.file_path)!
      disk.set(e.file_path, old.replace(e.old_string, e.new_string))
      return {
        result: {
          filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: old,
          structuredPatch: [], userModified: false, replaceAll: false,
        },
      } as never
    })

    await $.turn.start({ text: 'create the file', turnId: 't1' })
    await $.tool.call({ tool: 'Write', file_path: '/p/a.ts', content: 'one\ntwo\n' })
    await $.tool.call({ tool: 'Edit', file_path: '/p/a.ts', old_string: 'two', new_string: 'TWO' })
    await $.turn.start({ text: 'add a line', turnId: 't2' })
    await $.tool.call({ tool: 'Edit', file_path: '/p/a.ts', old_string: 'TWO', new_string: 'TWO\nthree' })

    const ui = await $.ui.mount({ plugin: 'session-replay', surface, component: 'Pane', requestId: 'session-replay', props: PANE_PROPS })
    // Defaults to the latest step: prompt 2's only edit.
    expect((await ui.find({ key: 'edit-2' }))?.text).toContain('#2.1 Edit a.ts')
    let code = await ui.findAll({ type: 'Code' })
    expect(code.length).toBe(1)
    expect(String(code[0].props.source)).toContain('+three')
    expect(String(code[0].props.source)).not.toContain('+one')

    await ui.press({ key: 'cumulative' })
    code = await ui.findAll({ type: 'Code' })
    expect(String(code[0].props.source)).toContain('+one')
    expect(String(code[0].props.source)).toContain('+three')

    // Back to prompt 1's first edit (the Write), restore there.
    await ui.press({ key: 'prompt-0' })
    await ui.press({ key: 'next' })
    expect((await ui.find({ key: 'edit-0' }))?.text).toContain('› ')
    await ui.press({ key: 'restore' })
    await ui.press({ key: 'restore-yes' })
    expect(disk.get('/p/a.ts')).toBe('one\ntwo\n')

    // The restore is its own stage, now the latest.
    expect((await ui.find({ key: 'prompt-2' }))?.text).toContain('restored to')
  })
}

test('autoplay walks every step and stops at the end', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'Write' }, ($, e) => ({
    result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null },
  }) as never)
  await $.turn.start({ text: 'two files', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/p/a.ts', content: 'a\n' })
  await $.tool.call({ tool: 'Write', file_path: '/p/b.ts', content: 'b\n' })

  const ui = await $.ui.mount({ plugin: 'session-replay', surface: 'desktop', component: 'Pane', requestId: 'session-replay', props: PANE_PROPS })
  await ui.press({ key: 'play' })
  expect((await ui.find({ key: 'prompt-0' }))?.text).toContain('› ')
  await clock.advance(1500)
  expect((await ui.find({ key: 'edit-0' }))?.text).toContain('› ')
  await clock.advance(1500)
  expect((await ui.find({ key: 'edit-1' }))?.text).toContain('› ')
  expect((await ui.find({ key: 'play' }))?.text).toContain('Play')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`edit rows and the prompt band open the pane (${surface})`, async ($, on) => {
    const opened: string[] = []
    on('ui.open', ($, e) => (opened.push(e.id), { value: { isPlaced: true } }) as never)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('tool.call', { tool: 'Write' }, ($, e) => ({
      result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null },
    }) as never)
    // Stand in for the engine's own drawing of a tool row and of the empty band.
    on('ui.render', { component: 'ToolUse' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: `engine row ${e.props.tool_use_id}` } as never)
    })
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box } = $.ui.resolve(e)
      return Box({} as never)
    })

    const band = await $.ui.mount({
      plugin: 'session-replay', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await band.find({ key: 'open-replay' })).toBe(undefined)

    await $.turn.start({ text: 'two files', turnId: 't1' })
    await $.tool.call({ tool: 'Write', file_path: '/p/a.ts', content: 'a\n', tool_use_id: 'tu-a' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/p/b.ts', content: 'b\n', tool_use_id: 'tu-b' } as never)

    const rowProps = (id: string) => ({
      tool_use_id: id, tool: 'Write', input: {}, isRunning: false, isErrored: false, isInterrupted: false,
    })
    const plain = await $.ui.mount({ plugin: 'session-replay', surface, component: 'ToolUse', requestId: 'tu-x', props: rowProps('tu-x') })
    expect(await plain.find({ type: 'Button' })).toBe(undefined)

    const row = await $.ui.mount({ plugin: 'session-replay', surface, component: 'ToolUse', requestId: 'tu-a', props: rowProps('tu-a') })
    expect((await row.find({ type: 'Text' }))?.text).toContain('engine row tu-a')
    await row.press({ key: 'replay-tu-a' })
    expect(opened).toEqual(['session-replay'])

    const pane = await $.ui.mount({ plugin: 'session-replay', surface, component: 'Pane', requestId: 'session-replay', props: PANE_PROPS })
    expect((await pane.find({ key: 'edit-0' }))?.text).toContain('› ')

    await band.redraw()
    expect((await band.find({ type: 'Text' }))?.text).toContain('2 change(s) to 2 file(s)')
    await band.press({ key: 'open-replay' })
    expect(opened.length).toBe(2)
  })
}
