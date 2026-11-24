import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { AlertTriangle } from 'lucide-react'
import { api, extOf, I, KIND, mimeOf, motionUrl, thumbUrl, vaultFileUrl, vaultThumbUrl, viewUrl, type Item, type OcrLine } from '../api'
import { VideoPlayer, type VideoHandle } from './VideoPlayer'
import { LiveText } from './LiveText'

export interface StageHandle {
  zoomBy: (f: number) => void
  fit: () => void
  actual: () => void
  rotate: (deg: number) => void
  resetRotation: () => void
  togglePlay: () => boolean
  seek: (s: number) => void
  video: () => VideoHandle | null
}

interface Props {
  item: Item
  wheel: 'zoom' | 'navigate'
  onNavigate: (dir: number) => void
  onZoomChange: (pct: number | null) => void
  onVideoEnded?: () => void
  onToggleFullscreen?: () => void
  autoplay: boolean
  /** Private-album item: `path` is a vault id, `name` the real file name. */
  vault?: { name: string }
  motion?: boolean
  ocr?: OcrLine[] | null
}

interface Xf {
  s: number | null // null = fit
  x: number
  y: number
}

const MAX = 32

export const Stage = forwardRef<StageHandle, Props>(function Stage(
  { item, wheel, onNavigate, onZoomChange, onVideoEnded, onToggleFullscreen, autoplay, vault, motion, ocr },
  ref,
) {
  const path = item[I.path]
  const isVideo = item[I.kind] === KIND.video
  const boxRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<VideoHandle>(null)
  const thumbSrc = vault ? vaultThumbUrl(path) : thumbUrl(path, 640)
  const fullSrc = vault ? vaultFileUrl(path, mimeOf(vault.name)) : viewUrl(path)
  const [box, setBox] = useState({ w: 1, h: 1 })
  const [dims, setDims] = useState<{ w: number; h: number } | null>(
    item[I.w] && item[I.h] ? { w: item[I.w], h: item[I.h] } : null,
  )
  const [fullLoaded, setFullLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [rot, setRot] = useState(0)
  const [xf, setXf] = useState<Xf>({ s: null, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const lastWheelNav = useRef(0)

  // The Viewer keys <Stage> by path, so each file gets fresh state; no reset effect needed.
  const imgRef = useRef<HTMLImageElement>(null)
  const onImgLoad = useCallback((im: HTMLImageElement) => {
    setDims((d) => (d && d.w === im.naturalWidth && d.h === im.naturalHeight ? d : { w: im.naturalWidth, h: im.naturalHeight }))
    setFullLoaded(true)
  }, [])
  // A cached image can finish before React attaches onLoad.
  useLayoutEffect(() => {
    const im = imgRef.current
    if (im?.complete && im.naturalWidth) onImgLoad(im)
  }, [onImgLoad])

  useLayoutEffect(() => {
    const el = boxRef.current!
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const swapped = rot % 180 !== 0
  const rw = dims ? (swapped ? dims.h : dims.w) : 1
  const rh = dims ? (swapped ? dims.w : dims.h) : 1
  const fitScale = dims ? Math.min(box.w / rw, box.h / rh, 1) : 1
  const scale = xf.s ?? fitScale

  useEffect(() => {
    onZoomChange(dims ? Math.round(scale * devicePixelRatio * 100) : null)
  }, [scale, dims, onZoomChange])

  const clamp = useCallback(
    (s: number, x: number, y: number): Xf => {
      const dw = rw * s
      const dh = rh * s
      const mx = Math.max(0, (dw - box.w) / 2)
      const my = Math.max(0, (dh - box.h) / 2)
      return { s, x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) }
    },
    [rw, rh, box],
  )

  const zoomAt = useCallback(
    (s2: number, cx = box.w / 2, cy = box.h / 2) => {
      setXf((cur) => {
        const s = cur.s ?? fitScale
        const next = Math.max(Math.min(fitScale, 0.05), Math.min(MAX, s2))
        if (Math.abs(next - fitScale) < 0.001) return { s: null, x: 0, y: 0 }
        const mx = cx - box.w / 2
        const my = cy - box.h / 2
        const x = mx - ((mx - cur.x) * next) / s
        const y = my - ((my - cur.y) * next) / s
        return clamp(next, x, y)
      })
    },
    [box, fitScale, clamp],
  )

  useImperativeHandle(
    ref,
    () => ({
      zoomBy: (f) => zoomAt(scale * f),
      fit: () => setXf({ s: null, x: 0, y: 0 }),
      actual: () => zoomAt(1 / devicePixelRatio),
      rotate: (deg) => {
        setRot((r) => r + deg)
        setXf({ s: null, x: 0, y: 0 })
      },
      resetRotation: () => setRot(0),
      togglePlay: () => {
        if (!videoRef.current) return false
        videoRef.current.toggle()
        return true
      },
      seek: (s) => videoRef.current?.seek(s),
      video: () => videoRef.current,
    }),
    [zoomAt, scale],
  )

  // Wheel: zoom (to cursor) or navigate. Non-passive so Ctrl+wheel doesn't zoom the WebView.
  useEffect(() => {
    const el = boxRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (isVideo && !e.ctrlKey) {
        const now = Date.now()
        if (now - lastWheelNav.current > 250) {
          lastWheelNav.current = now
          onNavigate(e.deltaY > 0 ? 1 : -1)
        }
        return
      }
      if (wheel === 'navigate' && !e.ctrlKey) {
        const now = Date.now()
        if (now - lastWheelNav.current > 220) {
          lastWheelNav.current = now
          onNavigate(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1)
        }
        return
      }
      const r = el.getBoundingClientRect()
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018))
      zoomAt(scale * f, e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [wheel, zoomAt, scale, onNavigate, isVideo])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || isVideo) return
    if ((e.target as HTMLElement).closest('.live-text')) return
    if (xf.s === null || scale <= fitScale + 0.001) {
      // Not zoomed: dragging moves the borderless window, like a title bar.
      if (e.detail === 1) getCurrentWindow().startDragging().catch(() => {})
      return
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, tx: xf.x, ty: xf.y }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    setXf(clamp(scale, d.tx + e.clientX - d.x, d.ty + e.clientY - d.y))
  }
  const onPointerUp = () => (drag.current = null)
  const onDoubleClick = (e: React.MouseEvent) => {
    if (isVideo) return
    const r = boxRef.current!.getBoundingClientRect()
    if (xf.s === null) zoomAt(Math.max(1 / devicePixelRatio, fitScale * 2), e.clientX - r.left, e.clientY - r.top)
    else setXf({ s: null, x: 0, y: 0 })
  }

  const w = dims?.w ?? 0
  const h = dims?.h ?? 0
  const transform = `translate(-50%, -50%) translate(${xf.x}px, ${xf.y}px) rotate(${rot}deg) scale(${scale})`
  const zoomed = xf.s !== null && scale > fitScale + 0.001
  const pixelated = scale * devicePixelRatio > 3

  return (
    <div
      ref={boxRef}
      className={`stage${zoomed ? ' zoomed' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {isVideo ? (
        <VideoPlayer
          ref={videoRef}
          path={vault ? vault.name : path}
          src={vault ? vaultFileUrl(path, mimeOf(vault.name)) : undefined}
          autoplay={autoplay}
          onEnded={onVideoEnded}
          onToggleFullscreen={onToggleFullscreen}
        />
      ) : failed ? null : (
        <div className="stage-layer" style={dims ? { width: w, height: h, transform } : undefined}>
          {!fullLoaded && dims && (
            <img className="stage-thumb" src={thumbSrc} width={w} height={h} draggable={false} alt="" />
          )}
          <img
            key={fullSrc}
            className={`stage-img${fullLoaded ? ' in' : ''}${pixelated ? ' pixelated' : ''}`}
            src={fullSrc}
            width={w || undefined}
            height={h || undefined}
            decoding="async"
            draggable={false}
            ref={imgRef}
            onLoad={(e) => onImgLoad(e.currentTarget)}
            onError={() => setFailed(true)}
            alt=""
          />
          {motion && (
            <div className="motion-layer">
              <VideoPlayer path={path} src={motionUrl(path)} autoplay loop minimal />
            </div>
          )}
          {ocr && ocr.length > 0 && <LiveText lines={ocr} w={w} h={h} />}
        </div>
      )}
      {!dims && !failed && !isVideo && <div className="spinner" />}
      {failed && !isVideo && <Unsupported path={path} />}
    </div>
  )
})

function Unsupported({ path }: { path: string }) {
  return (
    <div className="unsupported">
      <img className="unsupported-thumb" src={thumbUrl(path, 640)} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
      <AlertTriangle size={28} />
      <p>
        This file couldn't be decoded (.{extOf(path)})
      </p>
      <div className="row">
        <button className="btn" onClick={() => api.openExternal(path)}>
          Open in default app
        </button>
        <button className="btn" onClick={() => api.openWith(path)}>
          Open with…
        </button>
      </div>
    </div>
  )
}
