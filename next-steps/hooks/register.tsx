import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Band, Suggestion } from '../types'

const EMPTY: Band = { suggestions: [], selected: [], drafted: '' }
const band = atom({ plugin: 'next-steps', key: 'band' } as const, EMPTY)

const SYSTEM = `You suggest what the user of a Claude Code coding session should do next.
Reply with only a JSON array of 1 to 4 objects, most useful first:
[{"label": "<imperative, under 50 characters>", "prompt": "<the full prompt the user would send Claude to do it>"}]
Suggest only concrete steps that follow from the conversation. No prose outside the JSON.`

function parse(text: string): Suggestion[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) return []
  try {
    const list: unknown = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(list)) return []
    return list
      .filter(s => typeof s?.label === 'string' && typeof s?.prompt === 'string' && s.label && s.prompt)
      .slice(0, 4)
      .map(s => ({ label: s.label.slice(0, 80), prompt: s.prompt }))
  } catch {
    return []
  }
}

/**
 * The draft with the mod's own tail swapped for the selected steps' prompts.
 * The person's text before it is kept; if they edited the tail, it is kept too
 * and the new tail goes after it.
 */
function redraft(draft: string, drafted: string, steps: string[]): { text: string; drafted: string } {
  const base = drafted && draft.endsWith(drafted) ? draft.slice(0, -drafted.length) : draft
  const tail = steps.length === 0 ? '' : (/\S$/.test(base) ? '\n' : '') + steps.join('\n')
  return { text: base + tail, drafted: tail }
}

export const register: Register = on => {
  let lastPrompt = ''
  let currentTurn = ''

  on('turn.start', async ($, e, next) => {
    currentTurn = e.turnId
    if (e.text) lastPrompt = e.text
    await update($, band, () => EMPTY)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.reason !== 'answer' || !e.answer) return result

    const turnId = e.turnId
    const prompt = `The user's last request:\n${lastPrompt.slice(0, 2000)}\n\nClaude's reply:\n${e.answer.slice(-4000)}`
    // Off the turn's dispatch, so the session is idle while Haiku thinks.
    $.clock.after(0, async () => {
      const r = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt, maxTokens: 600, effort: 'low', timeoutMs: 20000 })
      // A newer turn started meanwhile: these suggestions are stale.
      if (!r.isAnswered || turnId !== currentTurn) return
      await update($, band, () => ({ ...EMPTY, suggestions: parse(r.text) }))
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    await update($, band, () => EMPTY)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { suggestions, selected } = await read($, band)
    if (suggestions.length === 0 || e.props.hasSurvey || e.props.isWorking || e.props.view.agentId) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const plain = e.surface === 'terminal' || undefined
    const toggle = async (i: number) => {
      const now = await read($, band)
      const picked = now.selected.includes(i) ? now.selected.filter(n => n !== i) : [...now.selected, i].sort((a, b) => a - b)
      const { text } = await $.prompt.read()
      const draft = redraft(text, now.drafted, picked.flatMap(n => now.suggestions[n]?.prompt ?? []))
      await $.prompt.fill({ text: draft.text, mode: 'replace' })
      await update($, band, b => ({ ...b, selected: picked, drafted: draft.drafted }))
    }

    return (
      <Box flexDirection={plain ? 'column' : 'row'} flexWrap="wrap" columnGap={1}>
        <Text dimColor>Next steps{plain ? ' (number toggles; ctrl+x tab to pick more once you have typed)' : ''}</Text>
        {suggestions.map((s, i) => (
          <Button
            key={`step-${i + 1}`}
            hotkey={String(i + 1)}
            plain={plain}
            variant={selected.includes(i) ? 'primary' : undefined}
            label={(selected.includes(i) ? '✓ ' : '') + s.label}
            onPress={() => toggle(i)}
          />
        ))}
        <Button
          key="dismiss"
          hotkey="0"
          plain={plain}
          role="dismiss"
          dimColor
          label="Dismiss"
          onPress={() => update($, band, () => EMPTY)}
        />
      </Box>
    )
  })
}
