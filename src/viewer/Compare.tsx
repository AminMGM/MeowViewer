import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { nameOf, viewUrl } from '../api'
import { useStore } from '../store'

/** Side-by-side compare (2–4 photos) with zoom/pan synced across panes. */
export function Compare({ paths }: { paths: string[] }) {
  const close = () => useStore.getState().setCompare(null)
  const [xf, setXf] = useState({ s: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      } else if (e.key === '0') setXf({ s: 1, x: 0, y: 0 })
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [])

  useEffect(() => {
    const el = root.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const pane = (e.target as HTMLElement).closest('.compare-pane') as HTMLElement | null
      if (!pane) return
      const r = pane.getBoundingClientRect()
      const mx = e.clientX - r.left - r.width / 2
      const my = e.clientY - r.top - r.height / 2
      setXf((c) => {
        const s = Math.max(1, Math.min(20, c.s * Math.exp(-e.deltaY * 0.0018)))
        if (s === 1) return { s: 1, x: 0, y: 0 }
        return { s, x: mx - ((mx - c.x) * s) / c.s, y: my - ((my - c.y) * s) / c.s }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      className={`compare n${paths.length}`}
      ref={root}
      onPointerDown={(e) => {
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        drag.current = { x: e.clientX, y: e.clientY, ox: xf.x, oy: xf.y }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d && xf.s > 1) setXf((c) => ({ ...c, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }))
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => setXf({ s: 1, x: 0, y: 0 })}
    >
      {paths.map((p) => (
        <div key={p} className="compare-pane">
          <img
            src={viewUrl(p)}
            draggable={false}
            style={{ transform: `translate(${xf.x}px, ${xf.y}px) scale(${xf.s})` }}
            alt=""
          />
          <span className="compare-name glass">{nameOf(p)}</span>
        </div>
      ))}
      <button className="icon-btn compare-close glass" onClick={close} title="Close (Esc)">
        <X size={18} />
      </button>
      <span className="compare-zoom glass">{Math.round(xf.s * 100)}% · wheel to zoom, drag to pan, double-click to reset</span>
    </div>
  )
}
