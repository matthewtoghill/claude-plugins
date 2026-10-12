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
  test(`${surface}: counts down, counts hits and misses, says what a cold cache re-caches`, async ($, on) => {
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
    expect(await lines($, surface)).toEqual(['🟢 Main (opus-5-5) 5:00 left of 5m · 10% hit · 0 misses'])

    await clock.advance(2 * 60 * 1000)
    await step($)
    await clock.advance(4 * 60 * 1000 + 30 * 1000)
    // 11200 read of 20510 input; 30s of 5m left.
    expect(await lines($, surface)).toEqual(['🟡 Main (opus-5-5) 0:30 left of 5m · 55% hit · 0 misses'])

    await clock.advance(3 * 60 * 1000)
    expect(await lines($, surface)).toEqual([
      '🔴 Main (opus-5-5) cold for 2m · next message re-caches 10.6k tokens · TTL 5m · 55% hit · 0 misses',
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

test('a hit after more than 5m switches the cache to 1h', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [{ cache_creation_input_tokens: 5000 }, { cache_read_input_tokens: 5000 }])
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: true })
  await step($)
  await clock.advance(10 * 60 * 1000)
  await step($)
  expect(await lines($, 'desktop')).toEqual(['🟢 Main (opus-5-5) 60:00 left of 1h · 50% hit · 0 misses'])
})

test('the ttl option sets the assumed TTL', { options: { ttl: '1h' } }, async ($, on) => {
  mock.clock(on)
  engine(on, [{ cache_creation_input_tokens: 5000 }])
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: true })
  await step($)
  expect((await lines($, 'desktop'))[0]).toContain('60:00 left of 1h')
})

test('a subagent gets its own row, gone once cold; /clear forgets the main one', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [{ cache_creation_input_tokens: 5000 }, { cache_creation_input_tokens: 3000 }])
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: true })
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' } as never)
  await step($)
  await step($, 'a1')
  expect(await lines($, 'desktop')).toEqual([
    '🟢 Main (opus-5-5) 5:00 left of 5m · 0% hit · 0 misses',
    '🟢 Explore (opus-5-5) 5:00 left of 5m · 0% hit · 0 misses',
  ])

  await clock.advance(6 * 60 * 1000)
  expect(await lines($, 'desktop')).toHaveLength(1)

  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(await lines($, 'desktop')).toEqual([])
})
