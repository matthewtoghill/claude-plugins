import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const MODEL = 'claude-opus-5-5'
// The band redraws every second, so advancing the mock clock by hours takes a while.
const SLOW = { timeoutMs: 30_000 }

/** Stubs the model beneath the mod: each step answers with the next usage in `queue`. */
function engine(on: On, queue: Partial<TurnUsage>[]) {
  on('session.start', () => ({ cwd: '/proj' }))
  on('classic.SessionStart', () => ({}))
  on('classic.SubagentStart', () => ({}))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  on('turn.step', async function* ($, e) {
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: MODEL, ...queue.shift() }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
}

async function step($: Engine, agentId?: string) {
  const s = $.turn.step({ turnId: 't', index: 0, model: MODEL, messageCount: 1, agentId })
  for await (const _ of s);
  return s.result
}

/** The band's lines, the terminal's dot read as the desktop's emoji so one expectation fits both. */
async function lines($: Engine, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: BAND })
  const icons = { green: '🟢', yellow: '🟡', red: '🔴' } as Record<string, string>
  return (await ui.findAll({ type: 'Text' })).map(t => {
    if (surface === 'desktop') return t.text
    expect(t.text.startsWith('● ')).toBe(true)
    return `${icons[String(t.props.color)]}${t.text.slice(1)}`
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: counts down, counts hits and misses, says what a cold cache re-caches`, SLOW, async ($, on) => {
    const clock = mock.clock(on)
    engine(on, [
      { cache_read_input_tokens: 1000, cache_creation_input_tokens: 9000, output_tokens: 200 },
      { cache_read_input_tokens: 10200, cache_creation_input_tokens: 300, input_tokens: 10, output_tokens: 90 },
      { cache_read_input_tokens: 1000, cache_creation_input_tokens: 9800 },
      { cache_read_input_tokens: 10800 },
    ])
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: true })
    expect(await lines($, surface)).toEqual([])

    await step($)
    expect(await lines($, surface)).toEqual(['🟢 Main (opus-5-5) 60:00 left of 1h · 10% hit · 0 misses'])

    await clock.advance(2 * 60 * 1000)
    await step($)
    await clock.advance(50 * 60 * 1000)
    // 11200 read of 20510 input; 10m of 1h left.
    expect(await lines($, surface)).toEqual(['🟡 Main (opus-5-5) 10:00 left of 1h · 55% hit · 0 misses'])

    await clock.advance(12 * 60 * 1000)
    expect(await lines($, surface)).toEqual([
      '🔴 Main (opus-5-5) cold for 2m · next message re-caches 10.6k tokens · TTL 1h · 55% hit · 0 misses',
    ])

    await step($)
    expect((await lines($, surface))[0]).toContain('· 1 miss')

    const ui = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: BAND })
    await ui.press({ key: 'cache-close' })
    expect(await lines($, surface)).toEqual([])
    await step($)
    expect(await lines($, surface)).toHaveLength(1)
  })
}

test("a subagent's hit after more than 5m switches its cache to 1h", async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [{ cache_creation_input_tokens: 5000 }, { cache_read_input_tokens: 5000 }])
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: true })
  await step($, 'a1')
  await clock.advance(6 * 60 * 1000)
  await step($, 'a1')
  expect(await lines($, 'desktop')).toEqual(['🟢 Subagent (opus-5-5) 60:00 left of 1h · 50% hit · 0 misses'])
})

test("the ttl option sets a subagent's assumed TTL", { options: { ttl: '1h' } }, async ($, on) => {
  mock.clock(on)
  engine(on, [{ cache_creation_input_tokens: 5000 }])
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: true })
  await step($, 'a1')
  expect((await lines($, 'desktop'))[0]).toContain('60:00 left of 1h')
})

test('keep warm forks the main cache just before it expires, until the picked time', SLOW, async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [{ cache_creation_input_tokens: 5000 }])
  let forks = 0
  on('model.fork', () => {
    forks++
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } } as never
  })
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: true })
  await step($)
  const ui = await $.ui.mount({ plugin: 'cache-clock', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await ui.select({ key: 'cache-warm', value: '2h' })
  expect((await lines($, 'desktop'))[0]).toContain('· kept warm 2h 0m more')

  await clock.advance(58 * 60 * 1000)
  expect(forks).toBe(0)
  await clock.advance(90 * 1000)
  expect(forks).toBe(1)
  // Pinged at 59:00, a minute before it expired.
  expect((await lines($, 'desktop'))[0]).toContain('59:30 left of 1h')

  // The second ping carries the cache past 2h, so there is no third.
  for (let h = 0; h < 3; h++) await clock.advance(60 * 60 * 1000)
  expect(forks).toBe(2)
  expect((await lines($, 'desktop'))[0]).toContain('cold for')
})

test('keep warm set to off forks nothing', SLOW, async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [{ cache_creation_input_tokens: 5000 }])
  let forks = 0
  on('model.fork', () => {
    forks++
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } } as never
  })
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: true })
  await step($)
  const ui = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.select({ key: 'cache-warm', value: '6h' })
  await ui.select({ key: 'cache-warm', value: 'off' })
  await clock.advance(2 * 60 * 60 * 1000)
  expect(forks).toBe(0)
})

test('a subagent gets its own row, gone once cold; /clear forgets the main one', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [{ cache_creation_input_tokens: 5000 }, { cache_creation_input_tokens: 3000 }])
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: true })
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' } as never)
  await step($)
  await step($, 'a1')
  expect(await lines($, 'desktop')).toEqual([
    '🟢 Main (opus-5-5) 60:00 left of 1h · 0% hit · 0 misses',
    '🟢 Explore (opus-5-5) 5:00 left of 5m · 0% hit · 0 misses',
  ])

  await clock.advance(6 * 60 * 1000)
  expect(await lines($, 'desktop')).toHaveLength(1)

  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(await lines($, 'desktop')).toEqual([])
})
