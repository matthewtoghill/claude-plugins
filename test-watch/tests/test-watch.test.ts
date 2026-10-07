import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

/** Stubs the engine beneath the mod: a vitest project, one test command result, and the prompt box `box.text`. */
function engine(on: On, box: { text: string }, result: { exitCode: number; stdout: string }) {
  const ran: string[][] = []
  on('session.start', () => ({ cwd: '/proj' }))
  on('session.cwd', () => ({ value: '/proj' }) as never)
  on('fs.list', () => ({ value: [{ name: 'package.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }) as never)
  on('fs.read', () => ({ value: JSON.stringify({ devDependencies: { vitest: '^3' } }) }) as never)
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    return { value: { ...result, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('tool.call', { tool: 'Edit' }, ($, e) => ({
    result: {
      filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: 'x',
      structuredPatch: [], userModified: false, replaceAll: false,
    },
  }) as never)
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    box.text = e.mode === 'append' ? box.text + e.text : e.text
    return { isFilled: true }
  })
  return ran
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: nothing runs until pressed; a failure drafts a fix prompt`, async ($, on) => {
    const clock = mock.clock(on)
    const box = { text: 'Also:' }
    const ran = engine(on, box, { exitCode: 1, stdout: 'FAIL src/a.test.ts\nexpected 2, got 3' })
    await $.session.start({ source: 'startup' } as never)

    let ui = await $.ui.mount({ plugin: 'test-watch', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ key: 'run' })).toBe(undefined)

    await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Edit', file_path: '/proj/src/my file.ts', old_string: 'a', new_string: 'b' })
    ui = await $.ui.mount({ plugin: 'test-watch', surface, component: 'AbovePrompt', props: BAND })
    expect(ran).toHaveLength(0)
    expect((await ui.find({ key: 'run' }))?.text).toContain('Run affected tests')
    expect(await ui.find({ key: 'fix' })).toBe(undefined)

    await ui.press({ key: 'run' })
    await clock.settle()
    expect(ran).toHaveLength(1)
    expect(ran[0]?.at(-1)).toBe('npx vitest related --run /proj/src/a.ts "/proj/src/my file.ts" 2>&1')

    ui = await $.ui.mount({ plugin: 'test-watch', surface, component: 'AbovePrompt', props: BAND })
    // The changed files were handed to that run; Run all needs fresh changes.
    expect((await ui.find({ key: 'run' }))?.text).toContain('Run tests')
    expect(await ui.find({ key: 'run-all' })).toBe(undefined)

    await ui.press({ key: 'fix' })
    expect(box.text).toContain('Also:\n\nThe tests failed (`npx vitest related --run')
    expect(box.text).toContain('expected 2, got 3')

    await ui.press({ key: 'tests-dismiss' })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  })
}

test('run all ignores the changed files; a pass offers no fix', async ($, on) => {
  const clock = mock.clock(on)
  const ran = engine(on, { text: '' }, { exitCode: 0, stdout: 'ok' })
  await $.session.start({ source: 'startup' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: 'a', new_string: 'b' })

  let ui = await $.ui.mount({ plugin: 'test-watch', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'run-all' })
  await clock.settle()
  expect(ran[0]?.at(-1)).toBe('npx vitest run 2>&1')

  ui = await $.ui.mount({ plugin: 'test-watch', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ key: 'fix' })).toBe(undefined)
  expect(await ui.find({ key: 'run' })).not.toBe(undefined)
})

test('the command option wins over detection', { options: { command: 'make check' } }, async ($, on) => {
  const clock = mock.clock(on)
  const ran = engine(on, { text: '' }, { exitCode: 0, stdout: 'ok' })
  await $.session.start({ source: 'startup' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ plugin: 'test-watch', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ key: 'run-all' })).toBe(undefined)
  await ui.press({ key: 'run' })
  await clock.settle()
  expect(ran[0]).toEqual(['sh', '-c', 'make check 2>&1'])
})
