import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, Columns2, Plus, RefreshCw, SplitSquareHorizontal, X } from 'lucide-react'
import { api, dirOf, I, KIND, nameOf, viewUrl, type Item } from '../api'
import { useStore } from '../store'
import { MediaGrid } from '../components/MediaGrid'

/**
 * Compare photos: side by side (2–4, synced zoom/pan) or a slider (two photos stacked, drag the divider).
 * Every pane can be swapped for another photo from the pool (the current view or folder).
 */
export function Compare({ paths: initial, pool: givenPool }: { paths: string[]; pool: Item[] | null }) {
  const close = () => useStore.getState().setCompare(null)
  const [paths, setPaths] = useState(initial)
  const [mode, setMode] = useState<'side' | 'slider'>('side')
  const [split, setSplit] = useState(50)
  const [xf, setXf] = useState({ s: 1, x: 0, y: 0 })
  const [picking, setPicking] = useState<number | null>(initial.length < 2 ? initial.length : null)
  const [pool, setPool] = useState<Item[] | null>(givenPool)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const splitting = useRef(false)
  const root = useRef<HTMLDivElement>(null)

  // No pool given: offer the photos in the same folder.
  useEffect(() => {
    if (pool || !initial[0]) return
    api.listDir(dirOf(initial[0])).then((items) => setPool(items.sort((a, b) => nameOf(a[I.path]).localeCompare(nameOf(b[I.path]), undefined, { numeric: true }))))
  }, [pool, initial])
  const photos = useMemo(() => (pool ?? []).filter((it) => it[I.kind] !== KIND.video), [pool])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (picking != null) setPicking(null)
        else close()
      } else if (e.key === '0') setXf({ s: 1, x: 0, y: 0 })
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [picking])

  useEffect(() => {
    const el = root.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.compare-picker')) return
      e.preventDefault()
      const pane = (e.target as HTMLElement).closest('.compare-pane, .compare-slider') as HTMLElement | null
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

  const transform = `translate(${xf.x}px, ${xf.y}px) scale(${xf.s})`
  const pick = (it: Item) => {
    const p = it[I.path]
    setPaths((cur) => {
      const next = [...cur]
      if (picking != null && picking < next.length) next[picking] = p
      else next.push(p)
      return next.slice(0, 4)
    })
    setPicking(null)
  }

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, .compare-picker')) return
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    if ((e.target as HTMLElement).closest('.split-handle')) {
      splitting.current = true
      return
    }
    drag.current = { x: e.clientX, y: e.clientY, ox: xf.x, oy: xf.y }
  }
  const onMove = (e: React.PointerEvent) => {
    if (splitting.current) {
      const r = root.current!.querySelector('.compare-slider')!.getBoundingClientRect()
      setSplit(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)))
      return
    }
    const d = drag.current
    if (d && xf.s > 1) setXf((c) => ({ ...c, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }))
  }

  const sideBySide = mode === 'side'
  const shown = sideBySide ? paths : paths.slice(0, 2)

  return (
    <div
      className="compare"
      ref={root}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={() => {
        drag.current = null
        splitting.current = false
      }}
      onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && setXf({ s: 1, x: 0, y: 0 })}
    >
      <header className="compare-bar glass">
        <div className="segmented">
          <button className={sideBySide ? 'on' : ''} onClick={() => setMode('side')}>
            <Columns2 size={15} /> Side by side
          </button>
          <button className={!sideBySide ? 'on' : ''} onClick={() => setMode('slider')} disabled={paths.length < 2}>
            <SplitSquareHorizontal size={15} /> Slider
          </button>
        </div>
        {sideBySide && paths.length < 4 && (
          <button className="btn" onClick={() => setPicking(paths.length)}>
            <Plus size={15} /> Add photo
          </button>
        )}
        {!sideBySide && (
          <button className="btn" onClick={() => setPaths((p) => [p[1], p[0], ...p.slice(2)])} title="Swap left and right">
            <ArrowLeftRight size={15} /> Swap
          </button>
        )}
        <span className="muted compare-hint">{Math.round(xf.s * 100)}% · wheel zooms, drag pans, double-click resets</span>
        <button className="icon-btn" onClick={close} title="Close (Esc)">
          <X size={18} />
        </button>
      </header>

      {sideBySide ? (
        <div className={`compare-grid n${Math.max(1, shown.length)}`}>
          {shown.map((p, i) => (
            <div key={`${i}:${p}`} className="compare-pane">
              <img src={viewUrl(p)} draggable={false} style={{ transform }} alt="" />
              <div className="compare-name glass">
                <span>{nameOf(p)}</span>
                <button className="icon-btn sm" title="Choose another photo" onClick={() => setPicking(i)}>
                  <RefreshCw size={13} />
                </button>
                {paths.length > 1 && (
                  <button className="icon-btn sm" title="Remove" onClick={() => setPaths((cur) => cur.filter((_, k) => k !== i))}>
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="compare-slider">
          <img src={viewUrl(shown[1])} draggable={false} style={{ transform }} alt="" />
          <img src={viewUrl(shown[0])} draggable={false} style={{ transform, clipPath: `inset(0 ${100 - split}% 0 0)` }} alt="" />
          <div className="split-line" style={{ left: `${split}%` }}>
            <span className="split-handle">
              <ArrowLeftRight size={16} />
            </span>
          </div>
          <span className="compare-name glass left">
            <span>{nameOf(shown[0])}</span>
            <button className="icon-btn sm" onClick={() => setPicking(0)} title="Choose another photo">
              <RefreshCw size={13} />
            </button>
          </span>
          <span className="compare-name glass right">
            <span>{nameOf(shown[1])}</span>
            <button className="icon-btn sm" onClick={() => setPicking(1)} title="Choose another photo">
              <RefreshCw size={13} />
            </button>
          </span>
        </div>
      )}

      {picking != null && (
        <div className="compare-picker glass" onPointerDown={(e) => e.stopPropagation()}>
          <header>
            <strong>{picking < paths.length ? `Replace “${nameOf(paths[picking])}”` : 'Choose a photo to compare'}</strong>
            <span className="spacer" />
            <button className="icon-btn sm" onClick={() => setPicking(null)}>
              <X size={15} />
            </button>
          </header>
          <div className="compare-picker-grid">
            {pool == null ? <div className="spinner small" /> : <MediaGrid items={photos} group="none" onOpen={(i) => pick(photos[i])} menuFor={() => []} />}
          </div>
        </div>
      )}
    </div>
  )
}
