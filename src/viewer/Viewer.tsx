import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  ArrowLeft, ChevronLeft, ChevronRight, CirclePlay, Expand, Heart, Info, LayoutGrid, Minimize2, Minus, MoreHorizontal,
  Pause, Play, Plus, RotateCcw, RotateCw, Scan, ScanText, Share2, Shrink, SlidersHorizontal, Square, Trash2, Undo2, X,
} from 'lucide-react'
import { api, bumpVersion, errText, extOf, I, KIND, nameOf, thumbUrl, vaultThumbUrl, viewUrl, type Item, type OcrLine } from '../api'
import { vaultMeta } from '../views/PrivateView'
import { toast, useStore } from '../store'
import { itemMenu, moveToTrash, renameItem, setFavorite, shareMenu } from '../actions'
import { openMenu, openMenuAt } from '../components/ui'
import { Stage, type StageHandle } from './Stage'
import { InfoPanel } from './InfoPanel'

const LOSSLESS_ROTATE = new Set(['jpg', 'jpeg', 'jfif', 'jpe', 'tif', 'tiff'])

export function Viewer() {
  const viewer = useStore((s) => s.viewer)!
  const settings = useStore((s) => s.settings)!
  const { closeViewer, setViewerIndex, patchSettings } = useStore.getState()
  const { items, index, origin } = viewer
  const item = items[index]
  const path = item?.[I.path]
  const stage = useRef<StageHandle>(null)
  const [ui, setUi] = useState(true)
  const [info, setInfo] = useState(false)
  const [zoom, setZoom] = useState<number | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [playing, setPlaying] = useState(!!viewer.slideshow)
  const hideTimer = useRef<number>(undefined)
  const hovering = useRef(false)
  const rotation = useRef({ quarters: 0, timer: 0 as number | undefined })
  const isVault = !!viewer.vault
  const vm = isVault && path ? vaultMeta.get(path) : undefined
  const displayName = vm ? vm.meta.name : path ? nameOf(path) : ''
  const isVideo = item?.[I.kind] === KIND.video
  const [motion, setMotion] = useState<{ path: string; on: boolean } | null>(null)
  const [ocr, setOcr] = useState<{ path: string; lines: OcrLine[] } | null>(null)

  // Motion photos (Samsung / Google): detect the embedded clip.
  useEffect(() => {
    if (!path || isVault || isVideo || !/\.(jpe?g|heic|heif)$/i.test(path)) return
    let live = true
    api.motionInfo(path).then((m) => {
      if (live && m) setMotion({ path, on: false })
    })
    return () => {
      live = false
    }
  }, [path, isVault, isVideo])
  const hasMotion = motion?.path === path
  const motionOn = hasMotion && motion!.on
  const liveText = ocr?.path === path ? ocr.lines : null

  const toggleLiveText = useCallback(async () => {
    if (!path || isVault || isVideo) return
    if (liveText) return setOcr(null)
    try {
      const lines = await api.ocrLines(path)
      if (!lines.length) return void toast('No text found in this photo')
      setOcr({ path, lines })
      toast('Select text on the photo, or copy it all', {
        label: 'Copy all',
        run: () => void api.copyText(lines.map((l) => l.text).join('\n')).then(() => toast('Text copied')),
      })
    } catch (e) {
      toast(errText(e))
    }
  }, [path, isVault, isVideo, liveText])

  const go = useCallback(
    (d: number) => {
      const n = items.length
      if (!n) return
      const next = playing ? (index + d + n) % n : Math.max(0, Math.min(n - 1, index + d))
      if (next !== index) setViewerIndex(next)
    },
    [items.length, index, playing, setViewerIndex],
  )

  // ---------------------------------------------------- auto-hide chrome
  const poke = useCallback(() => {
    setUi(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (!hovering.current) setUi(false)
    }, playing ? 900 : 1800)
  }, [playing])
  useEffect(() => {
    poke()
    return () => clearTimeout(hideTimer.current)
  }, [poke])

  useEffect(() => {
    const w = getCurrentWindow()
    w.isFullscreen().then(setFullscreen)
    w.isMaximized().then(setMaximized)
    const un = w.onResized(() => {
      w.isFullscreen().then(setFullscreen)
      w.isMaximized().then(setMaximized)
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

  const toggleFullscreen = useCallback(async () => {
    const w = getCurrentWindow()
    const fs = await w.isFullscreen()
    await w.setFullscreen(!fs)
    setFullscreen(!fs)
  }, [])

  // ------------------------------------------------------- preloading
  useEffect(() => {
    if (!item) return
    const keep: HTMLImageElement[] = []
    const t = window.setTimeout(() => {
      // Only the next image is pre-decoded at full size; going back uses the cached thumbnail first.
      for (const d of [1]) {
        const it = items[index + d]
        if (!it || it[I.kind] === KIND.video || isVault) continue
        const im = new Image()
        im.decoding = 'async'
        im.src = viewUrl(it[I.path])
        keep.push(im)
      }
    }, 120)
    return () => {
      clearTimeout(t)
      for (const im of keep) im.src = ''
    }
  }, [item, items, index])

  // -------------------------------------------------------- slideshow
  useEffect(() => {
    if (!playing || !item || item[I.kind] === KIND.video) return
    const t = window.setTimeout(() => go(1), settings.slideshowSecs * 1000)
    return () => clearTimeout(t)
  }, [playing, item, go, settings.slideshowSecs])

  // --------------------------------------------------------- rotation
  const rotate = useCallback(
    (q: number) => {
      if (!path || item[I.kind] === KIND.video) return
      stage.current?.rotate(q * 90)
      const r = rotation.current
      r.quarters += q
      clearTimeout(r.timer)
      if (!LOSSLESS_ROTATE.has(extOf(path))) {
        if (Math.abs(r.quarters) === 1) toast('Rotated in view only — this format has no lossless rotation')
        return
      }
      r.timer = window.setTimeout(async () => {
        const quarters = r.quarters
        r.quarters = 0
        if (quarters % 4 === 0) return
        try {
          await api.rotate(path, quarters)
          bumpVersion(path)
          stage.current?.resetRotation()
          useStore.getState().bumpLibrary()
        } catch (e) {
          toast(`Rotated in view only — ${errText(e)}`)
        }
      }, 700)
    },
    [path, item],
  )
  useEffect(() => {
    rotation.current.quarters = 0
  }, [path])

  // --------------------------------------------------------- keyboard
  const close = useCallback(() => {
    if (fullscreen) return toggleFullscreen()
    if (playing && viewer.slideshow) return closeViewer()
    if (origin === 'file') return
    closeViewer()
  }, [fullscreen, toggleFullscreen, playing, viewer.slideshow, origin, closeViewer])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, .modal, .menu')) return
      const k = e.key
      const ctrl = e.ctrlKey || e.metaKey
      poke()
      const vid = stage.current?.video()
      if (vid && ctrl && k === 'g') {
        e.preventDefault()
        return vid.jump()
      }
      if (vid && !ctrl) {
        const vk: Record<string, () => void> = {
          ArrowRight: () => vid.seek(5),
          ArrowLeft: () => vid.seek(-5),
          ArrowUp: () => vid.volume(0.05),
          ArrowDown: () => vid.volume(-0.05),
          m: () => vid.mute(),
          ',': () => vid.step(-1),
          '.': () => vid.step(1),
          '[': () => vid.speed(-1),
          ']': () => vid.speed(1),
          c: () => vid.captions(),
          v: () => vid.captions(),
          g: () => vid.subDelay(-0.05),
          h: () => vid.subDelay(0.05),
          l: () => vid.seek(10),
        }
        if (vk[k]) {
          e.preventDefault()
          return vk[k]()
        }
      }
      if (k === 'ArrowRight' || k === 'PageDown') go(1)
      else if (k === 'ArrowLeft' || k === 'PageUp') go(-1)
      else if (k === 'Home') setViewerIndex(0)
      else if (k === 'End') setViewerIndex(items.length - 1)
      else if (k === 'Escape') close()
      else if (k === 'F11' || (k === 'f' && !ctrl) || k === 'Enter') toggleFullscreen()
      else if (k === '+' || k === '=') stage.current?.zoomBy(1.25)
      else if (k === '-') stage.current?.zoomBy(0.8)
      else if (k === '0') stage.current?.fit()
      else if (k === '1') stage.current?.actual()
      else if (k === 'r' && !ctrl) rotate(e.shiftKey ? -1 : 1)
      else if (k === 'R') rotate(-1)
      else if (k === 'i' && !ctrl) setInfo((v) => !v)
      else if (k === 'l' && !ctrl && !isVault) setFavorite([path], !item[I.fav])
      else if (k === 'b' && !ctrl) patchSettings({ filmstrip: !settings.filmstrip })
      else if (k === 't' && !ctrl) toggleLiveText()
      else if (k === 'e' && !ctrl && !isVault && !isVideo) useStore.getState().setEditing(path)
      else if (k === 'Delete' && !isVault) moveToTrash([path])
      else if (k === 'F5') setPlaying((p) => !p)
      else if (k === ' ') {
        if (!stage.current?.togglePlay()) setPlaying((p) => !p)
      } else if (k === 'j') stage.current?.seek(-10)
      else if (k === 'k') stage.current?.togglePlay()
      else if (ctrl && k === 'c' && window.getSelection()?.toString()) return // copy selected Live Text
      else if (ctrl && k === 'c') api.copyImage(path).then(() => toast('Copied'), (er) => toast(errText(er)))
      else if (ctrl && k === 'p') api.print(path).catch((er) => toast(errText(er)))
      else if (k === 'F2') renameItem(path)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, close, toggleFullscreen, rotate, path, item, items.length, poke, settings.filmstrip, patchSettings, setViewerIndex, toggleLiveText, isVault, isVideo])

  const openGallery = async () => {
    const w = getCurrentWindow()
    if (await w.isFullscreen()) await w.setFullscreen(false)
    await w.maximize()

    closeViewer()
  }

  const vaultMenu = () => [
    {
      label: 'Restore from private album',
      icon: <Undo2 size={16} />,
      run: async () => {
        await api.vaultRestore([path]).then(() => toast('Restored to its original folder'), (e) => toast(errText(e)))
        useStore.getState().updateViewerItems((its) => its.filter((it) => it[I.path] !== path))
      },
    },
    {
      label: 'Delete permanently',
      icon: <Trash2 size={16} />,
      danger: true,
      run: async () => {
        await api.vaultDelete([path]).catch((e) => toast(errText(e)))
        useStore.getState().updateViewerItems((its) => its.filter((it) => it[I.path] !== path))
      },
    },
  ]
  const nextPhoto = items.slice(index + 1).find((it) => it[I.kind] !== KIND.video)?.[I.path]
  const menuFor = () => (isVault ? vaultMenu() : itemMenu(item, { compareWith: isVideo ? undefined : nextPhoto }))
  const more = (el: HTMLElement) => openMenuAt(el, menuFor(), 'right')

  if (!item) return null
  const bg = settings.viewerBg
  const zoomLabel = zoom == null ? '' : `${zoom}%`

  return (
    <div
      className={`viewer bg-${bg}${ui ? ' ui' : ''}${playing ? ' playing' : ''}`}
      onMouseMove={poke}
      onContextMenu={(e) => openMenu(e, menuFor())}
    >
      {bg === 'ambient' && (
        <div
          className="ambient"
          key={`ambient:${path}`}
          style={{ backgroundImage: `url("${isVault ? vaultThumbUrl(path) : thumbUrl(path, 320)}")` }}
        />
      )}

      <Stage
        ref={stage}
        key={path}
        item={item}
        wheel={settings.wheel}
        autoplay={true}
        onNavigate={go}
        onZoomChange={setZoom}
        onVideoEnded={() => (playing || settings.videoAutonext) && go(1)}
        onToggleFullscreen={toggleFullscreen}
        vault={vm ? { name: vm.meta.name } : undefined}
        motion={motionOn}
        ocr={liveText}
      />

      {/* ------------------------------------------------------- top bar */}
      <header
        className="viewer-top"
        data-tauri-drag-region
        onMouseEnter={() => (hovering.current = true)}
        onMouseLeave={() => (hovering.current = false)}
      >
        {origin === 'file' ? (
          <button className="icon-btn" onClick={openGallery} title="Open gallery">
            <LayoutGrid size={18} />
          </button>
        ) : (
          <button className="icon-btn" onClick={closeViewer} title="Back (Esc)">
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="viewer-title" data-tauri-drag-region>
          <span className="viewer-name" data-tauri-drag-region>
            {displayName}
          </span>
          <span className="viewer-count" data-tauri-drag-region>
            {index + 1} / {items.length}
          </span>
        </div>
        <div className="viewer-actions">
          {hasMotion && (
            <button
              className={`chip-btn motion-btn${motionOn ? ' on' : ''}`}
              onClick={() => setMotion({ path, on: !motionOn })}
              title="Play motion photo"
            >
              <CirclePlay size={15} /> Motion
            </button>
          )}
          {!isVault && !isVideo && (
            <>
              <button className={`icon-btn${liveText ? ' active' : ''}`} onClick={toggleLiveText} title="Live Text (T)">
                <ScanText size={18} />
              </button>
              <button className="icon-btn" onClick={() => useStore.getState().setEditing(path)} title="Edit (E)">
                <SlidersHorizontal size={18} />
              </button>
            </>
          )}
          {!isVault && (
            <button
              className={`icon-btn${item[I.fav] ? ' fav' : ''}`}
              onClick={() => setFavorite([path], !item[I.fav])}
              title="Favourite (L)"
            >
              <Heart size={18} fill={item[I.fav] ? 'currentColor' : 'none'} />
            </button>
          )}
          {item[I.kind] !== KIND.video && !isVault && (
            <>
              <button className="icon-btn" onClick={() => rotate(-1)} title="Rotate left (Shift+R)">
                <RotateCcw size={18} />
              </button>
              <button className="icon-btn" onClick={() => rotate(1)} title="Rotate right (R)">
                <RotateCw size={18} />
              </button>
            </>
          )}
          {!isVault && (
            <>
              <button className="icon-btn" onClick={(e) => openMenuAt(e.currentTarget, shareMenu([path]), 'right')} title="Share">
                <Share2 size={18} />
              </button>
              <button className="icon-btn" onClick={() => moveToTrash([path])} title="Delete (Del)">
                <Trash2 size={18} />
              </button>
              <button className={`icon-btn${info ? ' active' : ''}`} onClick={() => setInfo((v) => !v)} title="Info (I)">
                <Info size={18} />
              </button>
            </>
          )}
          <button className="icon-btn" onClick={(e) => more(e.currentTarget)} title="More">
            <MoreHorizontal size={18} />
          </button>
          <span className="divider" />
          <button className="icon-btn" onClick={toggleFullscreen} title="Full screen (F)">
            {fullscreen ? <Minimize2 size={17} /> : <Expand size={17} />}
          </button>
          {!fullscreen && <WindowButtons maximized={maximized} />}
        </div>
      </header>

      {/* ------------------------------------------------ side arrows */}
      {index > 0 && (
        <button className="nav-arrow left" onClick={() => go(-1)} aria-label="Previous">
          <ChevronLeft size={26} />
        </button>
      )}
      {index < items.length - 1 && (
        <button className="nav-arrow right" onClick={() => go(1)} aria-label="Next">
          <ChevronRight size={26} />
        </button>
      )}

      {/* ----------------------------------------------------- bottom */}
      <footer
        className="viewer-bottom"
        onMouseEnter={() => (hovering.current = true)}
        onMouseLeave={() => (hovering.current = false)}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {settings.filmstrip && items.length > 1 && !isVideo && (
          <Filmstrip items={items} index={index} onPick={setViewerIndex} vault={isVault} />
        )}
        <div className={`pill glass${isVideo ? ' hidden' : ''}`}>
          {item[I.kind] !== KIND.video && (
            <>
              <button className="icon-btn" onClick={() => stage.current?.zoomBy(0.8)} title="Zoom out (-)">
                <Minus size={17} />
              </button>
              <button className="zoom-label" onClick={() => stage.current?.fit()} title="Fit (0)">
                {zoomLabel}
              </button>
              <button className="icon-btn" onClick={() => stage.current?.zoomBy(1.25)} title="Zoom in (+)">
                <Plus size={17} />
              </button>
              <button className="icon-btn" onClick={() => stage.current?.actual()} title="Actual size (1)">
                <Scan size={17} />
              </button>
              <span className="divider" />
            </>
          )}
          <button className={`icon-btn${playing ? ' active' : ''}`} onClick={() => setPlaying((p) => !p)} title="Slideshow (F5)">
            {playing ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <button
            className={`icon-btn${settings.filmstrip ? ' active' : ''}`}
            onClick={() => patchSettings({ filmstrip: !settings.filmstrip })}
            title="Filmstrip (T)"
          >
            <LayoutGrid size={17} />
          </button>
        </div>
      </footer>

      {info && !isVault && <InfoPanel path={path} onClose={() => setInfo(false)} />}
    </div>
  )
}

export function WindowButtons({ maximized }: { maximized: boolean }) {
  const w = getCurrentWindow()
  return (
    <div className="win-buttons">
      <button className="win-btn" onClick={() => w.minimize()} aria-label="Minimize">
        <Minus size={15} />
      </button>
      <button className="win-btn" onClick={() => w.toggleMaximize()} aria-label="Maximize">
        {maximized ? <Shrink size={13} /> : <Square size={12} />}
      </button>
      <button className="win-btn close" onClick={() => w.close()} aria-label="Close">
        <X size={16} />
      </button>
    </div>
  )
}

function Filmstrip({ items, index, onPick, vault }: { items: Item[]; index: number; onPick: (i: number) => void; vault?: boolean }) {
  const W = 52
  const SPAN = 40
  const start = Math.max(0, index - SPAN)
  const end = Math.min(items.length, index + SPAN + 1)
  const slice = useMemo(() => items.slice(start, end), [items, start, end])
  return (
    <div className="filmstrip">
      <div className="filmstrip-track" style={{ transform: `translateX(${-(index - start) * (W + 4) - W / 2}px)` }}>
        {slice.map((it, k) => (
          <button
            key={`${start + k}:${it[I.path]}`}
            className={`film${start + k === index ? ' current' : ''}`}
            onClick={() => onPick(start + k)}
            style={{ width: W }}
          >
            <img
              src={vault ? vaultThumbUrl(it[I.path]) : thumbUrl(it[I.path], 320)}
              loading="lazy"
              decoding="async"
              draggable={false}
              alt=""
            />
          </button>
        ))}
      </div>
    </div>
  )
}


