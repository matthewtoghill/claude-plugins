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
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const REPLY = `Sure:\n[{"label":"Run the tests","prompt":"Run the test suite and fix failures"},{"label":"Commit","prompt":"Commit these changes"}]`

/** Stubs the engine beneath the mod; the prompt box is `box.text`. */
function engine(on: On, box: { text: string }) {
  const asked: { model: string; prompt: string }[] = []
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  on('model.complete', ($, e) => {
    asked.push({ model: e.model, prompt: e.prompt })
    return { value: { isAnswered: true, text: REPLY, usage: USAGE } }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    box.text = e.mode === 'append' ? box.text + e.text : e.text
    return { isFilled: true }
  })
  return asked
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: steps toggle in and out of the draft and the band stays`, async ($, on) => {
    const clock = mock.clock(on)
    const box = { text: '' }
    const asked = engine(on, box)

    await $.turn.start({ text: 'add a login form', turnId: 't1' })
    await $.turn.complete({ answer: 'Added LoginForm.tsx', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    expect(asked[0]?.model).toBe('haiku')
    expect(asked[0]?.prompt).toContain('add a login form')

    const ui = await $.ui.mount({ plugin: 'next-steps', surface, component: 'AbovePrompt', props: BAND })
    box.text = 'Also:'

    await ui.press({ key: 'step-1' })
    expect(box.text).toBe('Also:\nRun the test suite and fix failures')
    expect((await ui.find({ key: 'step-1' }))?.text).toContain('✓')

    await ui.press({ key: 'step-2' })
    expect(box.text).toBe('Also:\nRun the test suite and fix failures\nCommit these changes')

    await ui.press({ key: 'step-1' })
    expect(box.text).toBe('Also:\nCommit these changes')

    await ui.press({ key: 'step-2' })
    expect(box.text).toBe('Also:')
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
  })
}

test('an edited tail is kept and the next pick goes after it', async ($, on) => {
  const clock = mock.clock(on)
  const box = { text: '' }
  engine(on, box)
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await ui.press({ key: 'step-1' })
  box.text = 'Run the test suite only'
  await ui.press({ key: 'step-2' })
  expect(box.text).toBe('Run the test suite only\nRun the test suite and fix failures\nCommit these changes')
})

test('dismiss clears; subagent and aborted turns ask nothing', async ($, on) => {
  const clock = mock.clock(on)
  const asked = engine(on, { text: '' })

  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer', agentId: 'sub' })
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: true, turnId: 'b', reason: 'aborted' })
  await clock.settle()
  expect(asked).toHaveLength(0)

  await $.turn.start({ text: 'go', turnId: 'c' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'c', reason: 'answer' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'dismiss' })
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
})
