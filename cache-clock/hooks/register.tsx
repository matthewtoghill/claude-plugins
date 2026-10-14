import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { Cache } from '../types'

const MINUTE = 60 * 1000
const TTL_MS = { '5m': 5 * MINUTE, '1h': 60 * MINUTE } as const

const caches = atom({ plugin: 'cache-clock', key: 'caches' } as const, {})
const labels = atom({ plugin: 'cache-clock', key: 'labels' } as const, {})
const reportedTtl = atom({ plugin: 'cache-clock', key: 'ttlMs' } as const, null)
const isHidden = atom({ plugin: 'cache-clock', key: 'isHidden' } as const, false)
const keepWarm = atom({ plugin: 'cache-clock', key: 'keepWarm' } as const, null)

const WARM_OPTIONS = [{ value: 'off' }, ...[1, 2, 3, 4, 5, 6].map(h => ({ value: `${h}h` }))]
// Checked this often, so a failed ping is retried a few times inside the margin before the cache expires.
const WARM_EVERY = 15 * 1000
const WARM_MARGIN = MINUTE
let isWarming = false

let optionTtl: number = TTL_MS['5m']

/** The cache after one more request that started at `at` and cost `u`. */
function use(prev: Cache | undefined, u: TurnUsage, at: number, ttlMs: number): Pick<Cache, 'ttlMs' | 'usedAt' | 'cached' | 'context' | 'read' | 'input' | 'misses'> {
  const read = u.cache_read_input_tokens
  const isMiss = !!prev && read < prev.cached
  // A hit after a gap longer than 5m proves the cache lives for 1h.
  const isLongHit = !!prev && !isMiss && read > 0 && at - prev.usedAt > TTL_MS['5m']
  return {
    ttlMs: isLongHit ? TTL_MS['1h'] : (prev?.ttlMs ?? ttlMs),
    usedAt: at,
    cached: read + u.cache_creation_input_tokens,
    context: read + u.cache_creation_input_tokens + u.input_tokens + u.output_tokens,
    read: (prev?.read ?? 0) + read,
    input: (prev?.input ?? 0) + read + u.cache_creation_input_tokens + u.input_tokens,
    misses: (prev?.misses ?? 0) + (isMiss ? 1 : 0),
  }
}

async function track($: EngineInterface, agentId: string | undefined, u: TurnUsage, at: number) {
  const key = `${agentId ?? 'main'}:${u.model}`
  const label = agentId ? ((await read($, labels))[agentId] ?? 'Subagent') : 'Main'
  // The main thread's cache lives for 1h; the ttl option is for subagents'.
  const ttlMs = agentId ? optionTtl : ((await read($, reportedTtl)) ?? TTL_MS['1h'])
  await update($, caches, all => ({
    ...all,
    [key]: { label, model: u.model, isSubagent: !!agentId, ...use(all[key], u, at, ttlMs) },
  }))
}

function clock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function ago(ms: number) {
  const m = Math.floor(ms / MINUTE)
  return m < 1 ? `${Math.floor(ms / 1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function tokens(n: number) {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`
}

/** The main thread's cache on the model it last used. */
function latestMain(all: Record<string, Cache>) {
  return Object.entries(all)
    .filter(([, c]) => !c.isSubagent)
    .sort(([, a], [, b]) => b.usedAt - a.usedAt)[0]
}

/** Re-reads the main thread's cache through a fork when it is about to expire and should stay warm. */
async function warm($: EngineInterface) {
  const w = await read($, keepWarm)
  if (!w || isWarming) return
  const now = await $.clock.now()
  const main = latestMain(await read($, caches))
  if (!main) return
  const [key, c] = main
  const expiresAt = c.usedAt + c.ttlMs
  if (now >= w.until || expiresAt <= now || expiresAt - now > WARM_MARGIN || expiresAt >= w.until) return
  isWarming = true
  try {
    const r = await $.model.fork({ prompt: 'Keep-alive ping to refresh the prompt cache. Reply with just: ok' })
    // A fork that read nothing found the cache already gone; leave it cold.
    if (r.isAnswered && r.usage.cache_read_input_tokens > 0) {
      await update($, caches, all => (all[key] ? { ...all, [key]: { ...all[key], usedAt: now } } : all))
    }
  } finally {
    isWarming = false
  }
}

const ICONS = { green: '🟢', yellow: '🟡', red: '🔴' } as const

/** One band line for a cache at `now`, and its colour. */
function describe(c: Cache, now: number): { text: string; color: keyof typeof ICONS } {
  const left = c.usedAt + c.ttlMs - now
  const ttl = c.ttlMs >= TTL_MS['1h'] ? '1h' : `${Math.round(c.ttlMs / MINUTE)}m`
  const name = `${c.label} (${c.model.replace(/^claude-/, '')})`
  const stats = `${c.input ? Math.round((c.read / c.input) * 100) : 0}% hit · ${c.misses} ${c.misses === 1 ? 'miss' : 'misses'}`
  if (left <= 0) {
    return {
      text: `${name} cold for ${ago(-left)} · next message re-caches ${tokens(c.context)} tokens · TTL ${ttl} · ${stats}`,
      color: 'red',
    }
  }
  const isLow = left < c.ttlMs / 5
  return { text: `${name} ${clock(left)} left of ${ttl} · ${stats}`, color: isLow ? 'yellow' : 'green' }
}

export const register: Register = (on, options) => {
  optionTtl = options.ttl === '1h' ? TTL_MS['1h'] : TTL_MS['5m']

  on('session.start', ($, e, next) => {
    $.clock.every(1000, () => $.ui.invalidate('ui.render'))
    $.clock.every(WARM_EVERY, () => void warm($).catch(() => undefined))
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await update($, caches, () => ({}))
    return next(e)
  }).catch(() => undefined)

  on('classic.SubagentStart', async ($, e, next) => {
    await update($, labels, all => ({ ...all, [e.agent_id]: e.agent_type }))
    return next(e)
  }).catch(() => undefined)

  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, reportedTtl, () => TTL_MS[e.cache_ttl])
    return next(e)
  }).catch(() => undefined)

  on('turn.step', async function* ($, e, next) {
    // The TTL is refreshed when the request reads the cache, not when the response ends.
    const at = await $.clock.now()
    const r = yield* next(e)
    if (r.usage) {
      await track($, e.agentId, r.usage, at)
      if (!e.agentId) await update($, isHidden, () => false)
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await $.clock.now()
    // A cold subagent cache is never read again, so only the main thread's stay once cold.
    const shown = Object.entries(await read($, caches)).filter(([, c]) => !c.isSubagent || c.usedAt + c.ttlMs > now)
    if (e.props.hasSurvey || shown.length === 0 || (await read($, isHidden))) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // The mobile app draws no Select.
    const Select = 'Select' in ui ? ui.Select : undefined
    const plain = e.surface === 'terminal' || undefined
    const warmKey = latestMain(Object.fromEntries(shown))?.[0]
    const w = await read($, keepWarm)
    const warmLeft = w ? w.until - now : 0
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Box flexDirection="column">
            {shown.map(([key, c]) => {
              const { text, color } = describe(c, now)
              // Terminals disagree on these emoji's width (Unicode 12), which shifts the line's repaints; a dot is one cell everywhere.
              const line = <Text key={`cache-${key}`} color={color}>{plain ? '●' : ICONS[color]} {text}{key === warmKey && warmLeft > 0 ? ` · kept warm ${ago(warmLeft)} more` : ''}</Text>
              // Only the main thread's cache can be re-read by a fork.
              if (key !== warmKey || !Select) return line
              return (
                <Box key={`row-${key}`} flexDirection="row" columnGap={1}>
                  {line}
                  <Select
                    key="cache-warm"
                    label="Keep warm"
                    options={WARM_OPTIONS}
                    value={warmLeft > 0 ? w!.option : 'off'}
                    onSelect={value =>
                      update($, keepWarm, () => (value === 'off' ? null : { option: value, until: now + Number.parseInt(value) * TTL_MS['1h'] }))
                    }
                  />
                </Box>
              )
            })}
          </Box>
          <Button key="cache-close" role="dismiss" plain={plain} dimColor label="x" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {below}
      </Box>
    )
  })
}
