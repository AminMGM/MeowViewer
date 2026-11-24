/** Minimal subtitle parsing for SRT, WebVTT and ASS/SSA → timed cues. */
export interface Cue {
  start: number
  end: number
  text: string
}

const ts = (s: string) => {
  const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/)
  if (!m) return NaN
  return (+(m[1] ?? 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000
}

const clean = (t: string) =>
  t
    .replace(/\{[^}]*\}/g, '') // ASS override tags
    .replace(/\\N/gi, '\n')
    .replace(/<(?!\/?(b|i|u)>)[^>]+>/gi, '') // keep b/i/u only
    .trim()

function parseAss(text: string): Cue[] {
  const cues: Cue[] = []
  let fmt: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('Format:') && fmt.length === 0 && /Start/i.test(line)) {
      fmt = line.slice(7).split(',').map((s) => s.trim().toLowerCase())
    } else if (line.startsWith('Dialogue:')) {
      const parts = line.slice(9).split(',')
      const iStart = fmt.indexOf('start')
      const iEnd = fmt.indexOf('end')
      const iText = fmt.indexOf('text')
      if (iStart < 0 || iText < 0) continue
      const body = parts.slice(iText).join(',')
      cues.push({ start: ts(parts[iStart]), end: ts(parts[iEnd]), text: clean(body) })
    }
  }
  return cues.filter((c) => !isNaN(c.start)).sort((a, b) => a.start - b.start)
}

export function parseSubtitles(text: string): Cue[] {
  const t = text.replace(/^﻿/, '')
  if (/^\[Script Info\]/im.test(t)) return parseAss(t)
  const cues: Cue[] = []
  for (const block of t.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(Boolean)
    const i = lines.findIndex((l) => l.includes('-->'))
    if (i < 0) continue
    const [a, b] = lines[i].split('-->')
    const start = ts(a)
    const end = ts(b)
    if (isNaN(start) || isNaN(end)) continue
    cues.push({ start, end, text: clean(lines.slice(i + 1).join('\n')) })
  }
  return cues.sort((x, y) => x.start - y.start)
}

/** Active cues at time t (binary search on start). */
export function activeCues(cues: Cue[], t: number): Cue[] {
  let lo = 0
  let hi = cues.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].start <= t) lo = mid + 1
    else hi = mid
  }
  const out: Cue[] = []
  for (let i = lo - 1; i >= 0 && i >= lo - 8; i--) if (cues[i].end > t) out.unshift(cues[i])
  return out
}
