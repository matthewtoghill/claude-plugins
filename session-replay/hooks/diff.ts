// Pure line-diff helpers: no `$`, so tests can import them directly.

export type Hunk = { a: number; b: number; lines: string[] }
export type FileDiff = { file: string; hunks: Hunk[]; add: number; del: number }
type Op = [' ' | '-' | '+', string]

/** Lines for display: CRLF folded, control chars a Code element refuses replaced. */
export function lines(text: string | null): string[] {
  if (!text) return []
  const out = text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?').split('\n')
  if (out[out.length - 1] === '') out.pop()
  return out
}

export function ops(a: string[], b: string[]): Op[] {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const A = a.slice(p, a.length - s)
  const B = b.slice(p, b.length - s)
  const mid: Op[] = []
  // ponytail: O(n*m) LCS on the changed middle; whole-block replace past 2M cells. Myers if big rewrites get common.
  if (A.length * B.length > 2_000_000) {
    for (const x of A) mid.push(['-', x])
    for (const x of B) mid.push(['+', x])
  } else {
    const n = A.length
    const m = B.length
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (A[i] === B[j]) { mid.push([' ', A[i]]); i++; j++ }
      else if (L[i + 1][j] >= L[i][j + 1]) mid.push(['-', A[i++]])
      else mid.push(['+', B[j++]])
    }
    while (i < n) mid.push(['-', A[i++]])
    while (j < m) mid.push(['+', B[j++]])
  }
  const eq = (x: string): Op => [' ', x]
  return [...a.slice(0, p).map(eq), ...mid, ...a.slice(a.length - s).map(eq)]
}

export function hunks(o: Op[], ctx = 3): Hunk[] {
  const oi: number[] = []
  const ni: number[] = []
  let x = 0
  let y = 0
  for (const [t] of o) {
    oi.push(x); ni.push(y)
    if (t !== '+') x++
    if (t !== '-') y++
  }
  const ch = o.flatMap(([t], k) => (t === ' ' ? [] : [k]))
  const out: Hunk[] = []
  for (let i = 0; i < ch.length; ) {
    let j = i
    while (j + 1 < ch.length && ch[j + 1] - ch[j] - 1 <= 2 * ctx) j++
    const s = Math.max(0, ch[i] - ctx)
    const e = Math.min(o.length, ch[j] + ctx + 1)
    out.push({ a: oi[s], b: ni[s], lines: o.slice(s, e).map(([t, v]) => t + v) })
    i = j + 1
  }
  return out
}

export function fmt(h: Hunk): string {
  const ol = h.lines.filter(l => l[0] !== '+').length
  const nl = h.lines.filter(l => l[0] !== '-').length
  return `@@ -${ol ? h.a + 1 : h.a},${ol} +${nl ? h.b + 1 : h.b},${nl} @@\n${h.lines.join('\n')}`
}

export function fileDiff(file: string, before: string | null, after: string | null): FileDiff | undefined {
  if (before === after) return undefined
  const hs = hunks(ops(lines(before), lines(after)))
  if (!hs.length) return undefined
  const all = hs.flatMap(h => h.lines)
  return { file, hunks: hs, add: all.filter(l => l[0] === '+').length, del: all.filter(l => l[0] === '-').length }
}

/** Hunks as one Code `source` within `max` chars; a hunk too big alone is cut, its counts redone by fmt. */
export function clip(hs: Hunk[], max = 9000): { source: string; isCut: boolean } {
  const parts: string[] = []
  let size = 0
  for (const h of hs) {
    const text = fmt(h)
    if (size + text.length + 1 <= max) { parts.push(text); size += text.length + 1; continue }
    if (!parts.length) {
      const keep: string[] = []
      let n = 40
      for (const l of h.lines) { if (n + l.length + 1 > max) break; keep.push(l); n += l.length + 1 }
      parts.push(fmt({ ...h, lines: keep }))
    }
    return { source: parts.join('\n'), isCut: true }
  }
  return { source: parts.join('\n'), isCut: false }
}

export function patch(diffs: FileDiff[]): string {
  return diffs
    .map(d => `--- a/${d.file}\n+++ b/${d.file}\n${d.hunks.map(fmt).join('\n')}\n`)
    .join('')
}

/** One side of a diff's hunks as plain code: context plus '-' lines (old) or '+' lines (new), markers dropped. */
export function side(d: FileDiff, which: 'old' | 'new'): string {
  const drop = which === 'old' ? '+' : '-'
  return d.hunks.map(h => h.lines.filter(l => l[0] !== drop).map(l => l.slice(1)).join('\n')).join('\n…\n') + '\n'
}

/** `side` for every file; with more than one, each gets a `// path` header. */
export function sides(diffs: FileDiff[], which: 'old' | 'new'): string {
  if (diffs.length === 1) return side(diffs[0], which)
  return diffs.map(d => `// ${d.file}\n${side(d, which)}`).join('\n')
}

/** Rebuilds a file's old text from its new text and the hunks that produced it (a Bash edit's record). */
export function unapply(after: string, hs: { newStart: number; newLines: number; lines: string[] }[]): string {
  const now = after.split('\n')
  const old: string[] = []
  let at = 0
  for (const h of hs) {
    const start = h.newLines === 0 ? h.newStart : h.newStart - 1
    while (at < start) old.push(now[at++])
    for (const l of h.lines) {
      if (l[0] === ' ') { old.push(now[at++]) }
      else if (l[0] === '-') old.push(l.slice(1))
      else if (l[0] === '+') at++
    }
  }
  while (at < now.length) old.push(now[at++])
  return old.join('\n')
}
