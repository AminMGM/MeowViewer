import { useMemo } from 'react'
import type { OcrLine } from '../api'

const FONT = '"Segoe UI", system-ui, sans-serif'
let measureCtx: CanvasRenderingContext2D | null = null
const measure = (text: string, px: number) => {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  measureCtx!.font = `${px}px ${FONT}`
  return measureCtx!.measureText(text).width || 1
}

/**
 * Selectable text laid over the photo. Every word is scaled horizontally to exactly fill the
 * box the OCR found, so drag-selection lines up with what you see. Copy keeps line breaks.
 */
export function LiveText({ lines, w, h }: { lines: OcrLine[]; w: number; h: number }) {
  const words = useMemo(
    () =>
      lines.flatMap((line, li) =>
        line.words.map(([text, x, y, ww, hh], wi) => {
          const px = Math.max(4, hh * h * 0.92)
          const boxW = ww * w
          return { li, wi, text, left: x * w, top: y * h, width: boxW, height: hh * h, px, sx: boxW / measure(text, px) }
        }),
      ),
    [lines, w, h],
  )

  const onCopy = (e: React.ClipboardEvent) => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const spans = Array.from((e.currentTarget as HTMLElement).querySelectorAll('span[data-l]'))
    const picked = spans.filter((s) => sel.containsNode(s, true))
    if (!picked.length) return
    let out = ''
    let last = -1
    for (const s of picked) {
      const l = Number((s as HTMLElement).dataset.l)
      if (last !== -1) out += l === last ? ' ' : '\n'
      out += s.textContent
      last = l
    }
    e.clipboardData.setData('text/plain', out)
    e.preventDefault()
  }

  return (
    <div className="live-text" onPointerDown={(e) => e.stopPropagation()} onCopy={onCopy}>
      {words.map((wd) => (
        <span
          key={`${wd.li}-${wd.wi}`}
          data-l={wd.li}
          style={{
            left: wd.left,
            top: wd.top,
            height: wd.height,
            fontSize: wd.px,
            lineHeight: `${wd.height}px`,
            transform: `scaleX(${wd.sx})`,
          }}
        >
          {wd.text}
        </span>
      ))}
    </div>
  )
}
