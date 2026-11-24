import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight, Circle, Crop, Droplets, Eraser, FlipHorizontal2, FlipVertical2, Grid3x3, Highlighter, Palette, PenLine,
  Redo2, RotateCcw, RotateCw, Sparkles, Square, SunMedium, Type, Undo2, Wand2, X,
} from 'lucide-react'
import { api, bumpVersion, errText, extOf, nameOf, viewUrl } from '../api'
import { toast, useStore } from '../store'
import { prompt } from '../components/ui'
import { GlPass, ZERO, type Adjust, type Look } from './gl'

type Tool = 'pen' | 'highlight' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'blur' | 'pixelate'
interface Shape {
  tool: Tool
  color: string
  size: number
  pts: [number, number][] // normalised to the output frame
  text?: string
}
interface EditState {
  rot: number
  flipH: boolean
  flipV: boolean
  straighten: number
  crop: { x: number; y: number; w: number; h: number }
  adj: Adjust
  look: string
  shapes: Shape[]
}

const INITIAL: EditState = {
  rot: 0, flipH: false, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, adj: ZERO, look: 'none', shapes: [],
}

const LOOKS: Record<string, Look> = {
  none: {},
  vivid: { adj: { vibrance: 35, contrast: 15, clarity: 10 } },
  warm: { adj: { temperature: 30, vibrance: 10 } },
  cool: { adj: { temperature: -30, tint: -5 } },
  mono: { gray: 1, adj: { contrast: 15 } },
  noir: { gray: 1, adj: { contrast: 45, exposure: -8, vignette: 45, clarity: 20 } },
  matte: { adj: { fade: 45, contrast: -15, saturation: -10 } },
  vintage: { sepia: 0.45, adj: { fade: 25, vignette: 35, grain: 25 } },
  dramatic: { adj: { contrast: 35, highlights: -40, shadows: 30, clarity: 35, vignette: 35 } },
  chrome: { adj: { contrast: 25, vibrance: 25, temperature: -8 } },
  film: { adj: { fade: 20, grain: 35, temperature: 10, contrast: 10 } },
  pop: { adj: { saturation: 30, vibrance: 20, contrast: 20, shadows: 15 } },
}

const GROUPS: [string, [keyof Adjust, string, number, number][]][] = [
  ['Light', [['exposure', 'Exposure', -100, 100], ['contrast', 'Contrast', -100, 100], ['highlights', 'Highlights', -100, 100], ['shadows', 'Shadows', -100, 100], ['whites', 'Whites', -100, 100], ['blacks', 'Blacks', -100, 100]]],
  ['Colour', [['temperature', 'Temperature', -100, 100], ['tint', 'Tint', -100, 100], ['vibrance', 'Vibrance', -100, 100], ['saturation', 'Saturation', -100, 100]]],
  ['Detail & effects', [['sharpen', 'Sharpen', 0, 100], ['clarity', 'Clarity', -100, 100], ['vignette', 'Vignette', 0, 100], ['grain', 'Grain', 0, 100], ['fade', 'Fade', 0, 100]]],
]

const ASPECTS: [string, number | null][] = [['Free', null], ['Original', -1], ['1:1', 1], ['4:5', 4 / 5], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9], ['9:16', 9 / 16]]
const COLORS = ['#ffffff', '#111111', '#ff4d6d', '#ffb020', '#3ddc84', '#38bdf8', '#a78bfa']
const TOOLS: [Tool, string, React.ReactNode][] = [
  ['pen', 'Pen', <PenLine size={15} key="p" />],
  ['highlight', 'Highlighter', <Highlighter size={15} key="h" />],
  ['arrow', 'Arrow', <ArrowUpRight size={15} key="a" />],
  ['rect', 'Rectangle', <Square size={15} key="r" />],
  ['ellipse', 'Ellipse', <Circle size={15} key="e" />],
  ['text', 'Text', <Type size={15} key="t" />],
  ['blur', 'Blur', <Droplets size={15} key="b" />],
  ['pixelate', 'Pixelate', <Grid3x3 size={15} key="x" />],
]

/** Rotate/flip/straighten/crop into a canvas at `scale`. */
function geometry(src: CanvasImageSource & { width: number; height: number }, st: EditState, scale: number, withCrop: boolean, out: HTMLCanvasElement) {
  const W = src.width
  const H = src.height
  const odd = st.rot % 2 !== 0
  const OW = odd ? H : W
  const OH = odd ? W : H
  const c = withCrop ? st.crop : { x: 0, y: 0, w: 1, h: 1 }
  out.width = Math.max(1, Math.round(c.w * OW * scale))
  out.height = Math.max(1, Math.round(c.h * OH * scale))
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.save()
  ctx.scale(scale, scale)
  ctx.translate(-c.x * OW, -c.y * OH)
  ctx.translate(OW / 2, OH / 2)
  const rad = (st.straighten * Math.PI) / 180
  if (rad) {
    const cover = Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad)) * (Math.max(OW, OH) / Math.min(OW, OH))
    ctx.rotate(rad)
    ctx.scale(cover, cover)
  }
  ctx.rotate((st.rot * Math.PI) / 2)
  ctx.scale(st.flipH ? -1 : 1, st.flipV ? -1 : 1)
  ctx.drawImage(src, -W / 2, -H / 2)
  ctx.restore()
}

function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[], base: HTMLCanvasElement) {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const m = Math.min(W, H)
  for (const s of shapes) {
    const P = s.pts.map(([x, y]) => [x * W, y * H] as [number, number])
    if (!P.length) continue
    ctx.save()
    ctx.strokeStyle = ctx.fillStyle = s.color
    ctx.lineCap = ctx.lineJoin = 'round'
    ctx.lineWidth = s.size * m
    const [a, b] = [P[0], P[P.length - 1]]
    const rx = Math.min(a[0], b[0])
    const ry = Math.min(a[1], b[1])
    const rw = Math.abs(b[0] - a[0])
    const rh = Math.abs(b[1] - a[1])
    switch (s.tool) {
      case 'pen':
      case 'highlight':
        ctx.globalAlpha = s.tool === 'highlight' ? 0.35 : 1
        if (s.tool === 'highlight') ctx.lineWidth *= 3
        ctx.beginPath()
        ctx.moveTo(...P[0])
        for (const p of P.slice(1)) ctx.lineTo(...p)
        if (P.length === 1) ctx.lineTo(P[0][0] + 0.1, P[0][1])
        ctx.stroke()
        break
      case 'arrow': {
        ctx.beginPath()
        ctx.moveTo(...a)
        ctx.lineTo(...b)
        ctx.stroke()
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
        const hl = Math.max(ctx.lineWidth * 4, 12)
        ctx.beginPath()
        ctx.moveTo(...b)
        ctx.lineTo(b[0] - hl * Math.cos(ang - 0.45), b[1] - hl * Math.sin(ang - 0.45))
        ctx.lineTo(b[0] - hl * Math.cos(ang + 0.45), b[1] - hl * Math.sin(ang + 0.45))
        ctx.closePath()
        ctx.fill()
        break
      }
      case 'rect':
        ctx.strokeRect(rx, ry, rw, rh)
        break
      case 'ellipse':
        ctx.beginPath()
        ctx.ellipse(rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2)
        ctx.stroke()
        break
      case 'text':
        ctx.font = `600 ${s.size * m * 6}px "Segoe UI", sans-serif`
        ctx.textBaseline = 'top'
        ctx.lineWidth = s.size * m * 0.8
        ctx.strokeStyle = s.color === '#111111' ? '#ffffff' : '#000000'
        ctx.globalAlpha = 0.6
        ctx.strokeText(s.text ?? '', a[0], a[1])
        ctx.globalAlpha = 1
        ctx.fillText(s.text ?? '', a[0], a[1])
        break
      case 'blur':
        if (rw > 1 && rh > 1) {
          ctx.beginPath()
          ctx.rect(rx, ry, rw, rh)
          ctx.clip()
          ctx.filter = `blur(${Math.max(6, m * 0.02)}px)`
          ctx.drawImage(base, 0, 0, W, H)
        }
        break
      case 'pixelate':
        if (rw > 1 && rh > 1) {
          const cell = Math.max(6, m * 0.018)
          const t = document.createElement('canvas')
          t.width = Math.max(1, Math.round(rw / cell))
          t.height = Math.max(1, Math.round(rh / cell))
          t.getContext('2d')!.drawImage(base, rx * (base.width / W), ry * (base.height / H), rw * (base.width / W), rh * (base.height / H), 0, 0, t.width, t.height)
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(t, rx, ry, rw, rh)
        }
        break
    }
    ctx.restore()
  }
}

export function Editor({ path }: { path: string }) {
  const close = () => useStore.getState().setEditing(null)
  const view = useRef<HTMLCanvasElement>(null)
  const hist = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const gl = useRef<GlPass | null>(null)
  const geo = useRef(document.createElement('canvas'))
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [proxy, setProxy] = useState<HTMLCanvasElement | null>(null)
  const [st, setSt] = useState<EditState>(INITIAL)
  const [past, setPast] = useState<EditState[]>([])
  const [future, setFuture] = useState<EditState[]>([])
  const [tab, setTab] = useState<'crop' | 'adjust' | 'looks' | 'markup'>('adjust')
  const [aspect, setAspect] = useState<number | null>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(COLORS[2])
  const [size, setSize] = useState(0.006)
  const [box, setBox] = useState({ w: 800, h: 600 })
  const [saving, setSaving] = useState<null | 'ask' | 'busy'>(null)
  const [compare, setCompare] = useState(false)
  const drawing = useRef<Shape | null>(null)
  const cropDrag = useRef<{ mode: string; sx: number; sy: number; c: EditState['crop'] } | null>(null)

  useEffect(() => {
    try {
      gl.current = new GlPass()
    } catch {
      toast('GPU editing unavailable on this PC')
    }
    const im = new Image()
    im.crossOrigin = 'anonymous'
    im.decoding = 'async'
    im.onload = () => {
      setImg(im)
      // Preview proxy (≤ 2048 px) keeps every slider instant.
      const s = Math.min(1, 2048 / Math.max(im.naturalWidth, im.naturalHeight))
      const p = document.createElement('canvas')
      p.width = Math.round(im.naturalWidth * s)
      p.height = Math.round(im.naturalHeight * s)
      const c = p.getContext('2d')!
      c.imageSmoothingQuality = 'high'
      c.drawImage(im, 0, 0, p.width, p.height)
      setProxy(p)
    }
    im.onerror = () => toast("Couldn't load this image for editing")
    im.src = viewUrl(path)
    return () => gl.current?.dispose()
  }, [path])

  useLayoutEffect(() => {
    const el = wrap.current!
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const snapshot = useCallback(() => {
    setPast((p) => [...p.slice(-80), st])
    setFuture([])
  }, [st])
  const commit = (fn: (s: EditState) => EditState) => {
    snapshot()
    setSt(fn)
  }
  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p
      setFuture((f) => [st, ...f])
      setSt(p[p.length - 1])
      return p.slice(0, -1)
    })
  }, [st])
  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f
      setPast((p) => [...p, st])
      setSt(f[0])
      return f.slice(1)
    })
  }, [st])

  const oriented = useMemo(() => {
    if (!proxy) return { w: 1, h: 1 }
    const odd = st.rot % 2 !== 0
    return { w: odd ? proxy.height : proxy.width, h: odd ? proxy.width : proxy.height }
  }, [proxy, st.rot])
  const showCrop = tab === 'crop'
  const vis = showCrop ? oriented : { w: oriented.w * st.crop.w, h: oriented.h * st.crop.h }
  const fit = Math.min((box.w - 48) / vis.w, (box.h - 48) / vis.h)
  const cssW = vis.w * fit
  const cssH = vis.h * fit

  // Geometry changes only when crop/rotation does; adjustments re-run just the GPU pass.
  const geoKey = JSON.stringify([st.rot, st.flipH, st.flipV, st.straighten, showCrop ? null : st.crop])
  useEffect(() => {
    if (!proxy) return
    geometry(proxy, st, 1, !showCrop, geo.current)
    gl.current?.upload(geo.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxy, geoKey])

  useEffect(() => {
    const out = view.current
    if (!proxy || !out) return
    const id = requestAnimationFrame(() => {
      const g = gl.current
      const plain = compare
      if (g && !plain) g.draw(st.adj, LOOKS[st.look])
      const srcCanvas = g && !plain ? g.canvas : geo.current
      out.width = geo.current.width
      out.height = geo.current.height
      const ctx = out.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(srcCanvas, 0, 0)
      if (!showCrop && !plain) drawShapes(ctx, st.shapes, srcCanvas)
      // Histogram.
      const hc = hist.current
      if (hc) {
        const sw = Math.min(out.width, 400)
        const sh = Math.round((out.height / out.width) * sw)
        const t = document.createElement('canvas')
        t.width = sw
        t.height = sh
        const tx = t.getContext('2d', { willReadFrequently: true })!
        tx.drawImage(out, 0, 0, sw, sh)
        const d = tx.getImageData(0, 0, sw, sh).data
        const bins = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)]
        for (let i = 0; i < d.length; i += 4) {
          bins[0][d[i] >> 2]++
          bins[1][d[i + 1] >> 2]++
          bins[2][d[i + 2] >> 2]++
        }
        const hx = hc.getContext('2d')!
        hc.width = 268
        hc.height = 60
        const max = Math.max(1, ...bins.flatMap((b) => Array.from(b).slice(1, 63)))
        hx.globalCompositeOperation = 'lighter'
        ;['rgba(255,70,70,0.7)', 'rgba(70,220,110,0.7)', 'rgba(70,140,255,0.7)'].forEach((col, ci) => {
          hx.fillStyle = col
          hx.beginPath()
          hx.moveTo(0, 60)
          bins[ci].forEach((v, i) => hx.lineTo((i / 63) * 268, 60 - Math.min(1, v / max) * 60))
          hx.lineTo(268, 60)
          hx.fill()
        })
      }
    })
    return () => cancelAnimationFrame(id)
  }, [proxy, st, showCrop, compare, geoKey])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, .modal')) return
      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault()
        undo()
      } else if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault()
        redo()
      } else if (e.ctrlKey && e.key === 's') {
        e.preventDefault()
        setSaving('ask')
      } else if (e.key === 'Escape') close()
      else if (e.key === '\\') setCompare((c) => !c)
      e.stopPropagation()
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [undo, redo])

  // ---------------------------------------------------------- crop box
  const setAspectRatio = (r: number | null) => {
    setAspect(r)
    if (r == null) return
    const target = r === -1 ? oriented.w / oriented.h : r
    commit((s) => {
      const imgR = oriented.w / oriented.h
      let w = 1
      let h = imgR / target
      if (h > 1) {
        h = 1
        w = target / imgR
      }
      return { ...s, crop: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } }
    })
  }
  const onCropDown = (e: React.PointerEvent, mode: string) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    cropDrag.current = { mode, sx: e.clientX, sy: e.clientY, c: st.crop }
    snapshot()
  }
  const onCropMove = (e: React.PointerEvent) => {
    const d = cropDrag.current
    if (!d) return
    const dx = (e.clientX - d.sx) / cssW
    const dy = (e.clientY - d.sy) / cssH
    let { x, y, w, h } = d.c
    const min = 0.05
    if (d.mode === 'move') {
      x = Math.max(0, Math.min(1 - w, x + dx))
      y = Math.max(0, Math.min(1 - h, y + dy))
    } else {
      if (d.mode.includes('l')) {
        const nx = Math.max(0, Math.min(x + w - min, x + dx))
        w += x - nx
        x = nx
      }
      if (d.mode.includes('r')) w = Math.max(min, Math.min(1 - x, w + dx))
      if (d.mode.includes('t')) {
        const ny = Math.max(0, Math.min(y + h - min, y + dy))
        h += y - ny
        y = ny
      }
      if (d.mode.includes('b')) h = Math.max(min, Math.min(1 - y, h + dy))
      if (aspect != null) {
        const target = (aspect === -1 ? oriented.w / oriented.h : aspect) * (oriented.h / oriented.w)
        h = Math.min(1 - y, w / target)
        w = h * target
      }
    }
    setSt((s) => ({ ...s, crop: { x, y, w, h } }))
  }

  // ---------------------------------------------------------- markup
  const pos = (e: React.PointerEvent): [number, number] => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }
  const onDown = async (e: React.PointerEvent) => {
    if (tab !== 'markup') return
    const p = pos(e)
    if (tool === 'text') {
      const text = await prompt('Text', '', 'Add')
      if (text) commit((s) => ({ ...s, shapes: [...s.shapes, { tool, color, size, pts: [p], text }] }))
      return
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drawing.current = { tool, color, size, pts: [p] }
    commit((s) => ({ ...s, shapes: [...s.shapes, drawing.current!] }))
  }
  const onMove = (e: React.PointerEvent) => {
    if (cropDrag.current) return onCropMove(e)
    const d = drawing.current
    if (!d) return
    const p = pos(e)
    d.pts = d.tool === 'pen' || d.tool === 'highlight' ? [...d.pts, p] : [d.pts[0], p]
    setSt((s) => ({ ...s, shapes: [...s.shapes.slice(0, -1), { ...d }] }))
  }

  // ------------------------------------------------------------- save
  const save = async (mode: 'copy' | 'overwrite', fmt: 'jpg' | 'png' | 'webp', quality: number) => {
    if (!img) return
    setSaving('busy')
    try {
      const full = document.createElement('canvas')
      const g = gl.current
      const maxDim = g?.maxSize ?? 8192
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
      geometry(img, st, scale, true, full)
      const out = document.createElement('canvas')
      out.width = full.width
      out.height = full.height
      const ctx = out.getContext('2d')!
      if (g) {
        g.upload(full)
        g.draw(st.adj, LOOKS[st.look])
        ctx.drawImage(g.canvas, 0, 0)
      } else ctx.drawImage(full, 0, 0)
      drawShapes(ctx, st.shapes, g ? g.canvas : full)
      const mime = fmt === 'png' ? 'image/png' : fmt === 'webp' ? 'image/webp' : 'image/jpeg'
      const data = out.toDataURL(mime, quality / 100)
      full.width = full.height = out.width = out.height = 0
      if (g) {
        g.upload(geo.current)
      }
      const saved = await api.saveEdited(path, data, mode, fmt)
      bumpVersion(saved)
      toast(mode === 'copy' ? `Saved as ${nameOf(saved)}` : 'Saved — original backed up')
      close()
    } catch (e) {
      toast(errText(e))
      setSaving(null)
    }
  }

  const dirty = JSON.stringify(st) !== JSON.stringify(INITIAL)
  const cropStyle = { left: `${st.crop.x * 100}%`, top: `${st.crop.y * 100}%`, width: `${st.crop.w * 100}%`, height: `${st.crop.h * 100}%` }

  return (
    <div className="editor">
      <header className="editor-top">
        <button className="icon-btn" onClick={close} title="Close (Esc)">
          <X size={18} />
        </button>
        <strong className="editor-title">{nameOf(path)}</strong>
        <span className="spacer" />
        <button className="icon-btn" disabled={!past.length} onClick={undo} title="Undo (Ctrl+Z)">
          <Undo2 size={17} />
        </button>
        <button className="icon-btn" disabled={!future.length} onClick={redo} title="Redo (Ctrl+Y)">
          <Redo2 size={17} />
        </button>
        <button className={`btn${compare ? ' primary' : ''}`} onClick={() => setCompare((c) => !c)} title="Before / after (\)">
          Before
        </button>
        <button className="btn" disabled={!dirty} onClick={() => commit(() => INITIAL)}>
          Revert
        </button>
        <button className="btn primary" disabled={!dirty || !!saving} onClick={() => setSaving('ask')}>
          {saving === 'busy' ? 'Saving…' : 'Save'}
        </button>
      </header>

      <div className="editor-body">
        <div className="editor-stage" ref={wrap}>
          {!proxy && <div className="spinner" />}
          <div
            className={`editor-canvas-wrap${tab === 'markup' ? ' drawing' : ''}`}
            style={{ width: cssW, height: cssH }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={() => {
              drawing.current = null
              cropDrag.current = null
            }}
          >
            <canvas ref={view} style={{ width: cssW, height: cssH }} />
            {showCrop && (
              <div className="crop-box" style={cropStyle} onPointerDown={(e) => onCropDown(e, 'move')}>
                <span className="crop-grid" />
                {['tl', 'tr', 'bl', 'br', 't', 'b', 'l', 'r'].map((m) => (
                  <span key={m} className={`crop-h ${m}`} onPointerDown={(e) => onCropDown(e, m)} />
                ))}
              </div>
            )}
            {compare && <span className="before-badge">Before</span>}
          </div>
        </div>

        <aside className="editor-panel">
          <canvas className="editor-hist" ref={hist} />
          <div className="segmented editor-tabs">
            <button className={tab === 'crop' ? 'on' : ''} onClick={() => setTab('crop')} title="Crop & rotate">
              <Crop size={16} />
            </button>
            <button className={tab === 'adjust' ? 'on' : ''} onClick={() => setTab('adjust')} title="Adjust">
              <SunMedium size={16} />
            </button>
            <button className={tab === 'looks' ? 'on' : ''} onClick={() => setTab('looks')} title="Looks">
              <Palette size={16} />
            </button>
            <button className={tab === 'markup' ? 'on' : ''} onClick={() => setTab('markup')} title="Markup">
              <PenLine size={16} />
            </button>
          </div>

          {tab === 'crop' && (
            <div className="editor-section">
              <div className="row">
                <button className="btn" title="Rotate left" onClick={() => commit((s) => ({ ...s, rot: (s.rot + 3) % 4, crop: INITIAL.crop }))}>
                  <RotateCcw size={15} />
                </button>
                <button className="btn" title="Rotate right" onClick={() => commit((s) => ({ ...s, rot: (s.rot + 1) % 4, crop: INITIAL.crop }))}>
                  <RotateCw size={15} />
                </button>
                <button className="btn" title="Flip horizontal" onClick={() => commit((s) => ({ ...s, flipH: !s.flipH }))}>
                  <FlipHorizontal2 size={15} />
                </button>
                <button className="btn" title="Flip vertical" onClick={() => commit((s) => ({ ...s, flipV: !s.flipV }))}>
                  <FlipVertical2 size={15} />
                </button>
              </div>
              <label className="slider">
                <span>
                  Straighten <em>{st.straighten.toFixed(1)}°</em>
                </span>
                <input
                  type="range" min={-45} max={45} step={0.1} value={st.straighten}
                  onPointerDown={snapshot}
                  onChange={(e) => setSt((s) => ({ ...s, straighten: +e.target.value }))}
                  onDoubleClick={() => setSt((s) => ({ ...s, straighten: 0 }))}
                />
              </label>
              <div className="aspects">
                {ASPECTS.map(([label, r]) => (
                  <button key={label} className={`filter${aspect === r ? ' on' : ''}`} onClick={() => setAspectRatio(r)}>
                    {label}
                  </button>
                ))}
              </div>
              <button className="link-btn" onClick={() => commit((s) => ({ ...s, crop: INITIAL.crop, straighten: 0 }))}>
                Reset crop
              </button>
            </div>
          )}

          {tab === 'adjust' && (
            <div className="editor-section">
              <div className="row">
                <button
                  className="btn"
                  onClick={() => commit((s) => ({ ...s, adj: { ...ZERO, exposure: 5, contrast: 12, highlights: -25, shadows: 25, vibrance: 22, clarity: 12, sharpen: 15 } }))}
                >
                  <Sparkles size={15} /> Auto enhance
                </button>
                <button className="btn" onClick={() => commit((s) => ({ ...s, adj: ZERO }))}>
                  Reset
                </button>
              </div>
              {GROUPS.map(([g, sliders]) => (
                <div key={g} className="adj-group">
                  <h4>{g}</h4>
                  {sliders.map(([k, label, min, max]) => (
                    <label key={k} className={`slider${st.adj[k] ? ' changed' : ''}`}>
                      <span>
                        {label} <em>{st.adj[k] > 0 && min < 0 ? `+${st.adj[k]}` : st.adj[k]}</em>
                      </span>
                      <input
                        type="range" min={min} max={max} value={st.adj[k]}
                        onPointerDown={snapshot}
                        onChange={(e) => setSt((s) => ({ ...s, adj: { ...s.adj, [k]: +e.target.value } }))}
                        onDoubleClick={() => setSt((s) => ({ ...s, adj: { ...s.adj, [k]: 0 } }))}
                      />
                    </label>
                  ))}
                </div>
              ))}
              <p className="set-desc">Double-click a slider to reset it. Hold nothing — press \ for before/after.</p>
            </div>
          )}

          {tab === 'looks' && proxy && (
            <div className="editor-section filters-grid">
              {Object.keys(LOOKS).map((f) => (
                <LookThumb key={f} name={f} src={proxy} active={st.look === f} onPick={() => commit((s) => ({ ...s, look: f }))} />
              ))}
            </div>
          )}

          {tab === 'markup' && (
            <div className="editor-section">
              <div className="tool-grid">
                {TOOLS.map(([id, label, icon]) => (
                  <button key={id} className={`tool${tool === id ? ' on' : ''}`} onClick={() => setTool(id)} title={label}>
                    {icon}
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              {tool !== 'blur' && tool !== 'pixelate' && (
                <div className="swatches">
                  {COLORS.map((c) => (
                    <button key={c} className={`swatch${color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
                  ))}
                </div>
              )}
              <label className="slider">
                <span>Size</span>
                <input type="range" min={0.002} max={0.03} step={0.001} value={size} onChange={(e) => setSize(+e.target.value)} />
              </label>
              <button className="btn" disabled={!st.shapes.length} onClick={() => commit((s) => ({ ...s, shapes: [] }))}>
                <Eraser size={15} /> Clear markup
              </button>
              <p className="set-desc">
                {tool === 'blur' || tool === 'pixelate'
                  ? 'Drag over faces, plates or private text to hide them.'
                  : tool === 'text'
                    ? 'Click where the text should go.'
                    : 'Draw on the photo. Ctrl+Z removes the last mark.'}
              </p>
            </div>
          )}
        </aside>
      </div>

      {saving === 'ask' && <SaveDialog path={path} onCancel={() => setSaving(null)} onSave={save} />}
    </div>
  )
}

function SaveDialog({ path, onCancel, onSave }: { path: string; onCancel: () => void; onSave: (m: 'copy' | 'overwrite', f: 'jpg' | 'png' | 'webp', q: number) => void }) {
  const ext = extOf(path)
  const orig: 'jpg' | 'png' | 'webp' = ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : 'jpg'
  const [fmt, setFmt] = useState<'jpg' | 'png' | 'webp'>(orig)
  const [q, setQ] = useState(92)
  const [mode, setMode] = useState<'copy' | 'overwrite'>('copy')
  const canOverwrite = fmt === orig && ['jpg', 'jpeg', 'png', 'webp'].includes(ext)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal glass">
        <h3>
          <Wand2 size={17} /> Save edit
        </h3>
        <div className="segmented">
          {(['jpg', 'png', 'webp'] as const).map((f) => (
            <button key={f} className={fmt === f ? 'on' : ''} onClick={() => setFmt(f)}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        {fmt !== 'png' && (
          <label className="slider">
            <span>
              Quality <em>{q}</em>
            </span>
            <input type="range" min={50} max={100} value={q} onChange={(e) => setQ(+e.target.value)} />
          </label>
        )}
        <label className="check">
          <input type="radio" checked={mode === 'copy'} onChange={() => setMode('copy')} /> Save as a copy (keeps the original)
        </label>
        <label className={`check${canOverwrite ? '' : ' disabled'}`}>
          <input type="radio" disabled={!canOverwrite} checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} /> Replace the original
          (a backup is kept)
        </label>
        <p className="set-desc">JPEG keeps the original camera info, date and location. The file date stays the same.</p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(canOverwrite ? mode : 'copy', fmt, q)}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function LookThumb({ name, src, active, onPick }: { name: string; src: HTMLCanvasElement; active: boolean; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const out = ref.current!
    const s = 150 / Math.max(src.width, src.height)
    const small = document.createElement('canvas')
    small.width = Math.round(src.width * s)
    small.height = Math.round(src.height * s)
    small.getContext('2d')!.drawImage(src, 0, 0, small.width, small.height)
    try {
      const g = new GlPass()
      g.upload(small)
      g.draw(ZERO, LOOKS[name])
      out.width = small.width
      out.height = small.height
      out.getContext('2d')!.drawImage(g.canvas, 0, 0)
      g.dispose()
    } catch {
      /* no GPU */
    }
  }, [src, name])
  return (
    <button className={`filter-thumb${active ? ' on' : ''}`} onClick={onPick}>
      <canvas ref={ref} />
      <span>{name[0].toUpperCase() + name.slice(1)}</span>
    </button>
  )
}
