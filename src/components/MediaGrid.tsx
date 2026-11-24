import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, Columns2, Heart, Play } from 'lucide-react'
import { I, KIND, thumbUrl, type Item } from '../api'
import { useStore } from '../store'
import { itemMenu, startSlideshow } from '../actions'
import { openMenu, type MenuItem } from './ui'

type Row =
  | { t: 'h'; y: number; h: number; label: string; start: number; end: number }
  | { t: 'r'; y: number; h: number; start: number; end: number }

const GAP = 4
const PAD = 20
const HEADER = 52
const OVERSCAN = 700

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

function groupLabel(ms: number, by: 'day' | 'month') {
  const d = new Date(ms)
  if (by === 'month') return monthFmt.format(d)
  const today = new Date()
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return dayFmt.format(d)
}

function groupKey(ms: number, by: 'day' | 'month') {
  const d = new Date(ms)
  return by === 'month' ? d.getFullYear() * 12 + d.getMonth() : d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate()
}

/** Thumbnails already shown once: when they scroll back in they appear instantly (no fade = no flicker). */
const seen = new Set<string>()

interface Props {
  items: Item[]
  group: 'day' | 'month' | 'none'
  header?: React.ReactNode
  empty?: React.ReactNode
  /** Override how an item opens (e.g. trash). */
  onOpen?: (index: number) => void
  menuFor?: (item: Item, index: number) => MenuItem[]
  /** Custom thumbnail source (e.g. encrypted private-album items). */
  thumbFor?: (item: Item) => string
}

interface Handlers {
  click: (e: React.MouseEvent, i: number) => void
  check: (i: number) => void
  menu: (e: React.MouseEvent, i: number) => void
}

export function MediaGrid({ items, group, header, empty, onOpen, menuFor, thumbFor }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [headH, setHeadH] = useState(0)
  const [viewH, setViewH] = useState(800)
  // The rendered window only changes when rows enter/leave it, not on every scroll pixel.
  const [win, setWin] = useState({ a: 0, b: 0 })
  const [bubble, setBubble] = useState<string | null>(null)
  const bubbleTimer = useRef<number>(undefined)
  const raf = useRef(0)
  const anchor = useRef<number>(-1)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const selection = useStore((s) => s.selection)
  const target = settings?.gridSize ?? 180

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth)
      setViewH(el.clientHeight)
      setHeadH(headRef.current?.offsetHeight ?? 0)
    })
    ro.observe(el)
    if (headRef.current) ro.observe(headRef.current)
    return () => ro.disconnect()
  }, [])

  const cols = Math.max(2, Math.floor((width - PAD * 2 + GAP) / (target + GAP)))
  const tile = width ? Math.floor((width - PAD * 2 - GAP * (cols - 1)) / cols) : target

  const { rows, total } = useMemo(() => {
    const rows: Row[] = []
    let y = 0
    const pushRows = (start: number, end: number) => {
      for (let i = start; i < end; i += cols) {
        rows.push({ t: 'r', y, h: tile + GAP, start: i, end: Math.min(i + cols, end) })
        y += tile + GAP
      }
    }
    if (group === 'none') pushRows(0, items.length)
    else {
      let i = 0
      while (i < items.length) {
        const k = groupKey(items[i][I.date], group)
        let j = i + 1
        while (j < items.length && groupKey(items[j][I.date], group) === k) j++
        rows.push({ t: 'h', y, h: HEADER, label: groupLabel(items[i][I.date], group), start: i, end: j })
        y += HEADER
        pushRows(i, j)
        i = j
      }
    }
    return { rows, total: y + 40 }
  }, [items, cols, tile, group])

  const computeWindow = () => {
    const el = scrollRef.current
    if (!el) return
    const top = el.scrollTop - headH
    let lo = 0
    let hi = rows.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rows[mid].y + rows[mid].h < top - OVERSCAN) lo = mid + 1
      else hi = mid
    }
    let b = lo
    while (b < rows.length && rows[b].y < top + viewH + OVERSCAN) b++
    setWin((w) => (w.a === lo && w.b === b ? w : { a: lo, b }))
    return top
  }

  // Recompute when layout changes.
  useLayoutEffect(() => {
    computeWindow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, viewH, headH])

  const onScroll = () => {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      const top = computeWindow()
      if (group === 'none' || top === undefined) return
      // Floating date bubble while scrolling (Samsung-style).
      let label: string | null = null
      for (const r of rows) {
        if (r.y > top + 10) break
        if (r.t === 'h') label = r.label
      }
      setBubble((b) => (b === label ? b : label))
      clearTimeout(bubbleTimer.current)
      bubbleTimer.current = window.setTimeout(() => setBubble(null), 900)
    })
  }

  // Ctrl+wheel resizes tiles; must be non-passive to stop the WebView's page zoom.
  const targetRef = useRef(target)
  targetRef.current = target
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const next = Math.round(Math.max(90, Math.min(380, targetRef.current * (e.deltaY > 0 ? 0.88 : 1.14))))
      useStore.getState().patchSettings({ gridSize: next })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [patchSettings])

  // Stable handler object so memoised tiles don't re-render when the grid does.
  const latest = useRef({ items, onOpen, menuFor, selection })
  latest.current = { items, onOpen, menuFor, selection }
  const handlers = useMemo<Handlers>(() => {
    const open = (i: number) => {
      const { items, onOpen } = latest.current
      if (onOpen) return onOpen(i)
      useStore.getState().openViewer({ items, index: i, origin: 'gallery' })
    }
    return {
      click: (e, i) => {
        const { items, selection } = latest.current
        const setSelection = useStore.getState().setSelection
        const p = items[i][I.path]
        if (e.shiftKey && anchor.current >= 0) {
          const s = new Set(selection)
          const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)]
          for (let k = a; k <= b; k++) s.add(items[k][I.path])
          setSelection(s)
          return
        }
        anchor.current = i
        if (e.ctrlKey || selection.size > 0) {
          const s = new Set(selection)
          if (s.has(p)) s.delete(p)
          else s.add(p)
          setSelection(s)
          return
        }
        open(i)
      },
      check: (i) => {
        anchor.current = i
        useStore.getState().toggleSelect(latest.current.items[i][I.path])
      },
      menu: (e, i) => {
        const { items, menuFor, selection } = latest.current
        const it = items[i]
        if (menuFor) return openMenu(e, menuFor(it, i))
        const base = itemMenu(it, { open: () => open(i), slideshow: () => startSlideshow(items, i) })
        const sel = [...selection]
        const extra: MenuItem[] =
          sel.length >= 2 && sel.length <= 4
            ? [
                { label: `Compare ${sel.length} selected`, icon: <Columns2 size={16} />, run: () => useStore.getState().setCompare(sel) },
                { separator: true },
              ]
            : sel.length > 4
              ? [{ label: 'Select 2–4 photos to compare', icon: <Columns2 size={16} />, disabled: true }, { separator: true }]
              : []
        openMenu(e, [...extra, ...base])
      },
    }
  }, [])

  const selectGroup = (r: Row) => {
    const s = new Set(selection)
    const slice = items.slice(r.start, r.end)
    const all = slice.every((it) => s.has(it[I.path]))
    for (const it of slice) {
      if (all) s.delete(it[I.path])
      else s.add(it[I.path])
    }
    useStore.getState().setSelection(s)
  }

  // Year scrubber (Samsung-style): first header of each year, positioned proportionally.
  const years = useMemo(() => {
    if (group === 'none') return []
    const out: { year: number; y: number }[] = []
    for (const r of rows) {
      if (r.t !== 'h') continue
      const yr = new Date(items[r.start][I.date]).getFullYear()
      if (!out.length || out[out.length - 1].year !== yr) out.push({ year: yr, y: r.y })
    }
    return out.length > 1 && total > viewH * 3 ? out : []
  }, [rows, items, group, total, viewH])

  const thumbSize = tile * devicePixelRatio > 330 ? 640 : 320
  const selecting = selection.size > 0
  const visible = rows.slice(win.a, win.b)

  return (
    <div className={`grid-wrap${bubble ? ' scrolling' : ''}`}>
      <div className="grid-scroll" ref={scrollRef} onScroll={onScroll}>
        <div ref={headRef}>{header}</div>
        {items.length === 0 && empty}
        <div className="grid-canvas" style={{ height: total }}>
          {visible.map((r) =>
            r.t === 'h' ? (
              <div key={`h${r.start}`} className="grid-header" style={{ top: r.y, left: PAD, right: PAD, height: HEADER }}>
                <span>{r.label}</span>
                <span className="grid-header-count">{r.end - r.start}</span>
                <button className="link-btn" onClick={() => selectGroup(r)}>
                  Select
                </button>
              </div>
            ) : (
              Array.from({ length: r.end - r.start }, (_, k) => {
                const i = r.start + k
                const it = items[i]
                return (
                  <Tile
                    key={`${it[I.path]}|${i}`}
                    item={it}
                    index={i}
                    x={PAD + k * (tile + GAP)}
                    y={r.y}
                    size={tile}
                    thumb={thumbSize}
                    selected={selecting && selection.has(it[I.path])}
                    selecting={selecting}
                    h={handlers}
                    src={thumbFor?.(it)}
                  />
                )
              })
            ),
          )}
        </div>
      </div>
      {bubble && <div className="date-bubble glass">{bubble}</div>}
      {years.length > 0 && (
        <div className="scrubber">
          {years.map((y, i) => {
            const top = (y.y / total) * 100
            const prev = i ? (years[i - 1].y / total) * 100 : -10
            if (top - prev < 3.2 && i) return null
            return (
              <button
                key={y.year}
                style={{ top: `${top}%` }}
                onClick={() => scrollRef.current?.scrollTo({ top: y.y + headH, behavior: 'smooth' })}
              >
                {y.year}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface TileProps {
  item: Item
  index: number
  x: number
  y: number
  size: number
  thumb: number
  selected: boolean
  selecting: boolean
  h: Handlers
  src?: string
}

const Tile = memo(function Tile({ item, index, x, y, size, thumb, selected, selecting, h, src: custom }: TileProps) {
  const path = item[I.path]
  const src = custom ?? thumbUrl(path, thumb)
  const [loaded, setLoaded] = useState(() => seen.has(src))
  const [failed, setFailed] = useState(false)
  const kind = item[I.kind]
  return (
    <div
      className={`tile${selected ? ' selected' : ''}${selecting ? ' selecting' : ''}`}
      style={{ transform: `translate3d(${x}px, ${y}px, 0)`, width: size, height: size }}
      onClick={(e) => h.click(e, index)}
      onContextMenu={(e) => h.menu(e, index)}
      title={path.slice(path.lastIndexOf('\\') + 1)}
    >
      {!failed ? (
        <img
          src={src}
          decoding="async"
          draggable={false}
          className={loaded ? 'in' : ''}
          onLoad={() => {
            seen.add(src)
            setLoaded(true)
          }}
          onError={() => setFailed(true)}
          alt=""
        />
      ) : (
        <div className="tile-fallback">{path.slice(path.lastIndexOf('.') + 1).toUpperCase()}</div>
      )}
      {kind === KIND.video && (
        <span className="badge">
          <Play size={11} fill="currentColor" />
        </span>
      )}
      {kind === KIND.gif && <span className="badge">GIF</span>}
      {kind === KIND.raw && <span className="badge">RAW</span>}
      {item[I.fav] && <Heart className="tile-fav" size={15} fill="currentColor" />}
      <button
        className="tile-check"
        onClick={(e) => {
          e.stopPropagation()
          h.check(index)
        }}
        aria-label="Select"
      >
        <Check size={13} strokeWidth={3} />
      </button>
    </div>
  )
})
