import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  Camera, Captions, Download, Maximize, Pause, PictureInPicture2, Pin, Play, Repeat, RotateCw, Settings2, SkipBack,
  SkipForward, Volume1, Volume2, VolumeX, X,
} from 'lucide-react'
import { api, errText, extOf, fileUrl, thumbUrl, type Track } from '../api'
import { toast, useStore } from '../store'
import { openMenuAt, prompt } from '../components/ui'
import { activeCues, parseSubtitles, type Cue } from './subtitles'

export interface VideoHandle {
  toggle: () => void
  seek: (s: number) => void
  step: (frames: number) => void
  volume: (d: number) => void
  mute: () => void
  speed: (d: number) => void
  captions: () => void
  subDelay: (d: number) => void
  jump: () => void
}

/** Containers/codecs WebView2 can't play: convert straight away when the codec pack exists. */
const NEEDS_FFMPEG = new Set(['avi', 'wmv', 'asf', 'flv', 'f4v', 'mpg', 'mpeg', 'm2v', 'ts', 'm2ts', 'mts', 'vob', 'divx', 'rm', 'rmvb', '3g2', 'mxf', 'hevc'])
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 3]
const ASPECTS: [string, number | null][] = [['Auto', null], ['16:9', 16 / 9], ['4:3', 4 / 3], ['21:9', 21 / 9], ['1:1', 1], ['9:16', 9 / 16]]
const EQ_BANDS = [60, 230, 910, 3600, 14000]
const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0],
  'Bass boost': [7, 4, 0, 0, 0],
  Vocal: [-2, 0, 4, 3, 0],
  Treble: [0, 0, 0, 4, 7],
  Cinema: [5, 2, -1, 2, 4],
  Night: [-4, -1, 2, 2, -2],
}

const fmt = (t: number) => {
  if (!isFinite(t)) return '0:00'
  const s = Math.floor(t % 60)
  const m = Math.floor(t / 60) % 60
  const h = Math.floor(t / 3600)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}
const parseTime = (s: string) => {
  const p = s.trim().split(':').map(Number)
  if (p.some(isNaN)) return NaN
  return p.reduce((a, v) => a * 60 + v, 0)
}

// Resume points (like VLC): path → seconds, last 400 videos.
const RESUME_KEY = 'mv-resume'
const readResume = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}')
  } catch {
    return {}
  }
}
const writeResume = (path: string, t: number | null) => {
  try {
    const r = readResume()
    delete r[path]
    if (t != null) r[path] = Math.round(t)
    const keys = Object.keys(r)
    for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete r[k]
    localStorage.setItem(RESUME_KEY, JSON.stringify(r))
  } catch {
    /* storage unavailable */
  }
}

interface Props {
  path: string
  /** Override source (vault / motion photo). */
  src?: string
  autoplay: boolean
  loop?: boolean
  minimal?: boolean
  onEnded?: () => void
  onToggleFullscreen?: () => void
}

interface Audio {
  ctx: AudioContext
  gain: GainNode
  eq: BiquadFilterNode[]
}

export const VideoPlayer = forwardRef<VideoHandle, Props>(function VideoPlayer(
  { path, src, autoplay, loop, minimal, onEnded, onToggleFullscreen },
  ref,
) {
  const settings = useStore((s) => s.settings)!
  const patch = useStore((s) => s.patchSettings)
  const v = useRef<HTMLVideoElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const preview = useRef<HTMLVideoElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const audio = useRef<Audio | null>(null)
  const [url, setUrl] = useState<string | null>(src ?? (NEEDS_FFMPEG.has(extOf(path)) ? null : fileUrl(path)))
  const [state, setState] = useState<'ok' | 'convert' | 'need-codecs' | 'error'>(url ? 'ok' : 'convert')
  const [convertPct, setConvertPct] = useState(0)
  const [err, setErr] = useState('')
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [dur, setDur] = useState(0)
  const [buf, setBuf] = useState(0)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  const [looping, setLooping] = useState(!!loop)
  const [ab, setAb] = useState<{ a?: number; b?: number }>({})
  const [rot, setRot] = useState(0)
  const [aspect, setAspect] = useState<number | null>(null)
  const [fill, setFill] = useState(false)
  const [installing, setInstalling] = useState<number | null>(null)
  const [panel, setPanel] = useState<null | 'subs' | 'audio' | 'video' | 'play'>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [cues, setCues] = useState<Cue[] | null>(null)
  const [subLabel, setSubLabel] = useState<string | null>(null)
  const [subDelay, setSubDelay] = useState(0)
  const [subPos, setSubPos] = useState(8)
  const [audioTrack, setAudioTrack] = useState(0)
  const [boost, setBoost] = useState(100)
  const [eq, setEq] = useState('Flat')
  const [pic, setPic] = useState({ brightness: 100, contrast: 100, saturate: 100, hue: 0 })
  const [onTop, setOnTop] = useState(false)
  const [boxSize, setBoxSize] = useState({ w: 1, h: 1 })
  const resumeTarget = useRef<number | null>(null)

  const vol = settings.videoVolume
  const muted = vol === 0

  // ------------------------------------------------ source preparation
  const convert = useCallback(async () => {
    setState('convert')
    setConvertPct(0)
    try {
      if (!(await api.codecsInstalled())) return setState('need-codecs')
      const out = await api.prepareVideo(path)
      setUrl(fileUrl(out))
      setState('ok')
    } catch (e) {
      setErr(errText(e))
      setState('error')
    }
  }, [path])

  useEffect(() => {
    if (!url && !src) convert()
  }, [url, src, convert])

  useEffect(() => {
    const un = listen<[string, number, string]>('video-progress', (e) => {
      if (e.payload[0] === path) setConvertPct(e.payload[1])
    })
    const un2 = listen<{ stage: string; pct: number }>('codecs-progress', (e) => setInstalling(e.payload.pct))
    return () => {
      un.then((f) => f())
      un2.then((f) => f())
    }
  }, [path])

  // Tracks: sidecar subtitles, embedded subtitles/audio. Auto-load the first sidecar.
  useEffect(() => {
    if (src) return
    let live = true
    api.videoTracks(path).then(async (tr) => {
      if (!live) return
      setTracks(tr)
      const first = tr.find((x) => x.kind === 'file')
      if (first) loadTrack(first, true)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, src])

  const loadTrack = async (tr: Track | null, quiet = false) => {
    if (!tr) {
      setCues(null)
      setSubLabel(null)
      return
    }
    try {
      const text = tr.kind === 'embedded' ? await api.extractSubtitle(path, +tr.src) : await api.readSubtitle(tr.src)
      const c = parseSubtitles(text)
      setCues(c)
      setSubLabel(tr.label)
      if (!quiet) toast(`Subtitles: ${tr.label} (${c.length} lines)`)
    } catch (e) {
      toast(errText(e) === 'codecs-missing' ? 'Install the video codec pack to read embedded subtitles' : errText(e))
    }
  }

  // Resume where you left off.
  useEffect(() => {
    if (src || !settings.videoResume) return
    const r = readResume()[path]
    if (r && r > 10) resumeTarget.current = r
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, src])
  useEffect(() => {
    if (src) return
    const save = () => {
      const el = v.current
      if (!el || !el.duration) return
      const near = el.currentTime < 10 || el.currentTime > el.duration - 15
      writeResume(path, near ? null : el.currentTime)
    }
    const iv = setInterval(save, 5000)
    return () => {
      clearInterval(iv)
      save()
    }
  }, [path, src])

  // Persisted volume / speed (volume above 100% goes through the gain node).
  useEffect(() => {
    const el = v.current
    if (!el) return
    el.volume = Math.min(1, vol)
    el.muted = muted
  }, [vol, muted, url])
  useEffect(() => {
    if (v.current) v.current.playbackRate = settings.videoSpeed
  }, [settings.videoSpeed, url])

  // Web Audio graph only when boost/EQ are used (keeps idle playback lightweight).
  const ensureAudio = () => {
    if (audio.current || !v.current) return audio.current
    try {
      const ctx = new AudioContext()
      const srcNode = ctx.createMediaElementSource(v.current)
      const eqNodes = EQ_BANDS.map((f, i) => {
        const b = ctx.createBiquadFilter()
        b.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking'
        b.frequency.value = f
        b.Q.value = 1
        return b
      })
      const gain = ctx.createGain()
      let node: AudioNode = srcNode
      for (const b of eqNodes) {
        node.connect(b)
        node = b
      }
      node.connect(gain)
      gain.connect(ctx.destination)
      audio.current = { ctx, gain, eq: eqNodes }
    } catch {
      toast('Audio effects are not available for this video')
    }
    return audio.current
  }
  useEffect(() => {
    if (boost === 100 && eq === 'Flat' && !audio.current) return
    const a = ensureAudio()
    if (!a) return
    a.gain.gain.value = boost / 100
    EQ_PRESETS[eq].forEach((g, i) => (a.eq[i].gain.value = g))
  }, [boost, eq])
  useEffect(() => () => void audio.current?.ctx.close(), [])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setBoxSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [state])

  const step = (frames: number) => {
    const el = v.current
    if (!el) return
    el.pause()
    el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + frames / 30))
  }
  const jump = async () => {
    const s = await prompt('Jump to time (h:mm:ss or mm:ss)', fmt(v.current?.currentTime ?? 0), 'Go')
    if (!s) return
    const sec = parseTime(s)
    if (isNaN(sec) || !v.current) return toast('Use a time like 12:34')
    v.current.currentTime = Math.min(sec, v.current.duration || sec)
  }

  useImperativeHandle(ref, () => ({
    toggle: () => {
      const el = v.current
      if (!el) return
      if (el.paused) el.play()
      else el.pause()
    },
    seek: (s) => {
      const el = v.current
      if (el) el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + s))
    },
    step,
    volume: (d) => patch({ videoVolume: Math.round(Math.max(0, Math.min(1, vol + d)) * 100) / 100 }),
    mute: () => patch({ videoVolume: muted ? 1 : 0 }),
    speed: (d) => {
      const i = SPEEDS.indexOf(settings.videoSpeed)
      const n = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + d))]
      patch({ videoSpeed: n })
      toast(`Speed ${n}×`)
    },
    captions: () => {
      const subsTracks = tracks.filter((x) => x.kind !== 'audio')
      if (!subsTracks.length) return toast('No subtitles — load a file from the subtitle menu')
      const i = subsTracks.findIndex((x) => x.label === subLabel)
      const next = i + 1 < subsTracks.length ? subsTracks[i + 1] : null
      loadTrack(next)
      if (!next) toast('Subtitles off')
    },
    subDelay: (d) =>
      setSubDelay((x) => {
        const n = Math.round((x + d) * 100) / 100
        toast(`Subtitle delay ${n > 0 ? '+' : ''}${n.toFixed(2)} s`)
        return n
      }),
    jump,
  }))

  const onTime = () => {
    const el = v.current!
    setT(el.currentTime)
    if (ab.a != null && ab.b != null && el.currentTime >= ab.b) el.currentTime = ab.a
    if (el.buffered.length) setBuf(el.buffered.end(el.buffered.length - 1))
  }

  const seekTo = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    if (v.current) v.current.currentTime = f * dur
  }
  const onBarMove = (e: React.PointerEvent) => {
    const r = bar.current!.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    setHover({ x: e.clientX - r.left, t: f * dur })
    if (e.buttons === 1) seekTo(e.clientX)
    const p = preview.current
    if (p && Math.abs(p.currentTime - f * dur) > 0.4) p.currentTime = f * dur
  }

  const snapshot = async () => {
    const el = v.current
    if (!el) return
    const c = document.createElement('canvas')
    c.width = el.videoWidth
    c.height = el.videoHeight
    c.getContext('2d')!.drawImage(el, 0, 0)
    try {
      const out = await api.saveFrame(path, c.toDataURL('image/png'))
      toast(`Frame saved — ${out.slice(out.lastIndexOf('\\') + 1)}`)
    } catch (e) {
      toast(errText(e))
    }
  }

  const switchAudio = async (tr: Track) => {
    const idx = +tr.src
    if (idx === audioTrack) return
    const at = v.current?.currentTime ?? 0
    toast('Switching audio track…')
    try {
      const out = idx === 0 && !NEEDS_FFMPEG.has(extOf(path)) ? path : await api.videoWithAudio(path, idx)
      resumeTarget.current = at
      setUrl(fileUrl(out))
      setAudioTrack(idx)
    } catch (e) {
      toast(errText(e) === 'codecs-missing' ? 'Install the video codec pack to switch audio tracks' : errText(e))
    }
  }

  const installCodecs = async () => {
    setInstalling(0)
    try {
      await api.installCodecs()
      setInstalling(null)
      toast('Video codecs installed')
      convert()
    } catch (e) {
      setInstalling(null)
      toast(errText(e))
    }
  }

  if (state !== 'ok' || !url) {
    return (
      <div className="vp-status">
        <img className="vp-poster" src={thumbUrl(path, 1280)} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
        <div className="vp-status-card glass">
          {state === 'convert' && (
            <>
              <div className="spinner small" />
              <p>Preparing video… {convertPct > 0 ? `${Math.round(convertPct)}%` : ''}</p>
              <div className="vp-progress">
                <span style={{ width: `${convertPct}%` }} />
              </div>
            </>
          )}
          {state === 'need-codecs' && (
            <>
              <p>
                <strong>.{extOf(path)}</strong> needs the video codec pack (FFmpeg, about 90 MB, downloaded once).
              </p>
              {installing != null ? (
                <div className="vp-progress">
                  <span style={{ width: `${installing}%` }} />
                </div>
              ) : (
                <div className="row">
                  <button className="btn primary" onClick={installCodecs}>
                    <Download size={15} /> Install codecs
                  </button>
                  <button className="btn" onClick={() => api.openExternal(path)}>
                    Open in default app
                  </button>
                </div>
              )}
            </>
          )}
          {state === 'error' && (
            <>
              <p>{err || "This video couldn't be played."}</p>
              <div className="row">
                <button className="btn" onClick={() => api.openExternal(path)}>
                  Open in default app
                </button>
                <button className="btn" onClick={() => api.openWith(path)}>
                  Open with…
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  const pct = dur ? (t / dur) * 100 : 0
  const VolIcon = muted ? VolumeX : vol < 0.5 ? Volume1 : Volume2
  const subsTracks = tracks.filter((x) => x.kind !== 'audio')
  const audioTracks = tracks.filter((x) => x.kind === 'audio')
  const shown = cues ? activeCues(cues, t - subDelay) : []

  // Forced aspect ratio: size the video box ourselves and stretch into it.
  let videoStyle: React.CSSProperties = {
    objectFit: fill ? 'cover' : 'contain',
    filter: `brightness(${pic.brightness}%) contrast(${pic.contrast}%) saturate(${pic.saturate}%) hue-rotate(${pic.hue}deg)`,
    transform: rot ? `rotate(${rot}deg)` : undefined,
  }
  if (aspect) {
    const w = Math.min(boxSize.w, boxSize.h * aspect)
    const h = w / aspect
    videoStyle = { ...videoStyle, objectFit: 'fill', width: w, height: h, left: (boxSize.w - w) / 2, top: (boxSize.h - h) / 2, inset: 'auto' }
  }

  return (
    <div className={`vp${minimal ? ' minimal' : ''}`} ref={box}>
      <video
        ref={v}
        className="vp-video"
        src={url}
        poster={src ? undefined : thumbUrl(path, 1280)}
        autoPlay={autoplay}
        loop={looping}
        style={videoStyle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={onTime}
        onLoadedMetadata={(e) => {
          setDur(e.currentTarget.duration)
          const r = resumeTarget.current
          if (r != null && r < e.currentTarget.duration - 5) {
            e.currentTarget.currentTime = r
            if (audioTrack === 0 && r > 10)
              toast(`Resumed at ${fmt(r)}`, { label: 'Start over', run: () => v.current && (v.current.currentTime = 0) })
          }
          resumeTarget.current = null
        }}
        onEnded={() => {
          writeResume(path, null)
          onEnded?.()
        }}
        onClick={() => (v.current!.paused ? v.current!.play() : v.current!.pause())}
        onDoubleClick={onToggleFullscreen}
        onError={() => (src ? setState('error') : convert())}
        crossOrigin="anonymous"
      />
      {shown.length > 0 && (
        <div
          className="vp-subs"
          style={{
            bottom: `${subPos}%`,
            fontSize: `calc(clamp(16px, 2.6vh, 40px) * ${settings.subSize / 100})`,
          }}
        >
          {shown.map((c, i) => (
            <span
              key={i}
              style={{ color: settings.subColor, background: `rgba(0,0,0,${settings.subBg / 100})` }}
              dangerouslySetInnerHTML={{ __html: c.text.replace(/</g, (m, o: number, s: string) => (/^<\/?[biu]>/i.test(s.slice(o)) ? m : '&lt;')).replace(/\n/g, '<br/>') }}
            />
          ))}
        </div>
      )}
      {!minimal && (
        <div className="vp-controls glass" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <div
            className="vp-bar"
            ref={bar}
            onPointerDown={(e) => {
              ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
              seekTo(e.clientX)
            }}
            onPointerMove={onBarMove}
            onPointerLeave={() => setHover(null)}
          >
            <div className="vp-track">
              <span className="vp-buf" style={{ width: `${dur ? (buf / dur) * 100 : 0}%` }} />
              <span className="vp-fill" style={{ width: `${pct}%` }} />
              {ab.a != null && <span className="vp-ab" style={{ left: `${(ab.a / dur) * 100}%` }} />}
              {ab.b != null && <span className="vp-ab" style={{ left: `${(ab.b / dur) * 100}%` }} />}
              <span className="vp-knob" style={{ left: `${pct}%` }} />
            </div>
            {hover && (
              <div className="vp-hover glass" style={{ left: Math.max(70, Math.min(hover.x, (bar.current?.clientWidth ?? 0) - 70)) }}>
                <video ref={preview} src={url} muted preload="metadata" className="vp-hover-video" />
                <span>{fmt(hover.t)}</span>
              </div>
            )}
          </div>
          <div className="vp-row">
            <button className="icon-btn" onClick={() => (v.current!.paused ? v.current!.play() : v.current!.pause())} title="Play / pause (Space)">
              {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
            </button>
            <button className="icon-btn" onClick={() => (v.current!.currentTime -= 10)} title="Back 10 s (J)">
              <SkipBack size={17} />
            </button>
            <button className="icon-btn" onClick={() => (v.current!.currentTime += 10)} title="Forward 10 s (L)">
              <SkipForward size={17} />
            </button>
            <div className="vp-vol">
              <button className="icon-btn" onClick={() => patch({ videoVolume: muted ? 1 : 0 })} title="Mute (M)">
                <VolIcon size={18} />
              </button>
              <input type="range" min={0} max={1} step={0.01} value={vol} onChange={(e) => patch({ videoVolume: +e.target.value })} aria-label="Volume" />
            </div>
            <button className="vp-time" onClick={jump} title="Jump to time (Ctrl+G)">
              {fmt(t)} <span className="muted">/ {fmt(dur)}</span>
            </button>
            <span className="spacer" />
            <button
              className={`icon-btn${ab.a != null ? ' active' : ''}`}
              title="A-B loop: set A, then B, then clear"
              onClick={() => {
                const c = v.current!.currentTime
                if (ab.a == null) setAb({ a: c })
                else if (ab.b == null) setAb({ a: Math.min(ab.a, c), b: Math.max(ab.a, c) })
                else setAb({})
              }}
            >
              <span className="vp-ab-label">{ab.a == null ? 'A-B' : ab.b == null ? 'B?' : 'A-B ✓'}</span>
            </button>
            <button className={`icon-btn${looping ? ' active' : ''}`} onClick={() => setLooping((l) => !l)} title="Loop">
              <Repeat size={17} />
            </button>
            <button
              className="chip-btn vp-speed"
              onClick={(e) =>
                openMenuAt(
                  e.currentTarget,
                  SPEEDS.map((sp) => ({ label: `${sp}×`, hint: sp === settings.videoSpeed ? '✓' : undefined, run: () => patch({ videoSpeed: sp }) })),
                  'right',
                )
              }
              title="Speed ([ and ])"
            >
              {settings.videoSpeed}×
            </button>
            <button className={`icon-btn${cues ? ' active' : ''}`} onClick={() => setPanel(panel === 'subs' ? null : 'subs')} title="Subtitles (V)">
              <Captions size={18} />
            </button>
            <button className="icon-btn" onClick={snapshot} title="Save frame as PNG">
              <Camera size={17} />
            </button>
            <button className="icon-btn" onClick={() => setRot((r) => (r + 90) % 360)} title="Rotate">
              <RotateCw size={17} />
            </button>
            <button className={`icon-btn${fill ? ' active' : ''}`} onClick={() => setFill((f) => !f)} title="Fill / fit">
              <Maximize size={17} />
            </button>
            {document.pictureInPictureEnabled && (
              <button
                className="icon-btn"
                onClick={() => (document.pictureInPictureElement ? document.exitPictureInPicture() : v.current?.requestPictureInPicture())}
                title="Picture in picture"
              >
                <PictureInPicture2 size={17} />
              </button>
            )}
            <button className={`icon-btn${panel && panel !== 'subs' ? ' active' : ''}`} onClick={() => setPanel(panel ? null : 'audio')} title="Audio, picture & playback">
              <Settings2 size={17} />
            </button>
          </div>

          {panel && (
            <div className="vp-panel glass">
              <div className="vp-panel-tabs">
                {(['subs', 'audio', 'video', 'play'] as const).map((p) => (
                  <button key={p} className={panel === p ? 'on' : ''} onClick={() => setPanel(p)}>
                    {{ subs: 'Subtitles', audio: 'Audio', video: 'Picture', play: 'Playback' }[p]}
                  </button>
                ))}
                <span className="spacer" />
                <button className="icon-btn sm" onClick={() => setPanel(null)}>
                  <X size={14} />
                </button>
              </div>

              {panel === 'subs' && (
                <div className="vp-panel-body">
                  <div className="vp-list">
                    <button className={!cues ? 'on' : ''} onClick={() => loadTrack(null)}>
                      Off
                    </button>
                    {subsTracks.map((tr) => (
                      <button key={tr.kind + tr.src} className={subLabel === tr.label ? 'on' : ''} onClick={() => loadTrack(tr)}>
                        {tr.label}
                        {tr.kind === 'embedded' && <span className="muted"> · embedded</span>}
                      </button>
                    ))}
                    <button
                      onClick={async () => {
                        const f = await openDialog({
                          title: 'Load subtitles',
                          filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'ass', 'ssa'] }],
                        })
                        if (f && !Array.isArray(f)) loadTrack({ kind: 'file', src: f, label: f.slice(f.lastIndexOf('\\') + 1) })
                      }}
                    >
                      Load subtitle file…
                    </button>
                  </div>
                  <Slider label={`Delay ${subDelay > 0 ? '+' : ''}${subDelay.toFixed(2)} s  (G / H)`} min={-10} max={10} step={0.05} value={subDelay} onChange={setSubDelay} />
                  <Slider label={`Size ${settings.subSize}%`} min={50} max={250} step={5} value={settings.subSize} onChange={(x) => patch({ subSize: x })} />
                  <Slider label={`Background ${settings.subBg}%`} min={0} max={100} step={5} value={settings.subBg} onChange={(x) => patch({ subBg: x })} />
                  <Slider label={`Position ${subPos}%`} min={2} max={40} step={1} value={subPos} onChange={setSubPos} />
                  <div className="swatches">
                    {['#ffffff', '#ffe066', '#7cf7ff', '#b4ff9a'].map((c) => (
                      <button key={c} className={`swatch${settings.subColor === c ? ' on' : ''}`} style={{ background: c }} onClick={() => patch({ subColor: c })} />
                    ))}
                  </div>
                </div>
              )}

              {panel === 'audio' && (
                <div className="vp-panel-body">
                  {audioTracks.length > 1 && (
                    <div className="vp-list">
                      {audioTracks.map((tr) => (
                        <button key={tr.src} className={+tr.src === audioTrack ? 'on' : ''} onClick={() => switchAudio(tr)}>
                          {tr.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {audioTracks.length <= 1 && <p className="set-desc">One audio track{tracks.length ? '' : ' (install the codec pack to see embedded tracks)'}.</p>}
                  <Slider label={`Volume boost ${boost}%`} min={100} max={200} step={5} value={boost} onChange={setBoost} />
                  <div className="vp-list row-wrap">
                    {Object.keys(EQ_PRESETS).map((p) => (
                      <button key={p} className={eq === p ? 'on' : ''} onClick={() => setEq(p)}>
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {panel === 'video' && (
                <div className="vp-panel-body">
                  <Slider label={`Brightness ${pic.brightness}%`} min={30} max={200} step={1} value={pic.brightness} onChange={(x) => setPic({ ...pic, brightness: x })} />
                  <Slider label={`Contrast ${pic.contrast}%`} min={30} max={200} step={1} value={pic.contrast} onChange={(x) => setPic({ ...pic, contrast: x })} />
                  <Slider label={`Saturation ${pic.saturate}%`} min={0} max={250} step={1} value={pic.saturate} onChange={(x) => setPic({ ...pic, saturate: x })} />
                  <Slider label={`Hue ${pic.hue}°`} min={-180} max={180} step={1} value={pic.hue} onChange={(x) => setPic({ ...pic, hue: x })} />
                  <div className="vp-list row-wrap">
                    {ASPECTS.map(([l, a]) => (
                      <button key={l} className={aspect === a ? 'on' : ''} onClick={() => setAspect(a)}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <button className="link-btn" onClick={() => setPic({ brightness: 100, contrast: 100, saturate: 100, hue: 0 })}>
                    Reset picture
                  </button>
                </div>
              )}

              {panel === 'play' && (
                <div className="vp-panel-body">
                  <label className="check">
                    <input type="checkbox" checked={settings.videoResume} onChange={(e) => patch({ videoResume: e.target.checked })} /> Resume where I left off
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={settings.videoAutonext} onChange={(e) => patch({ videoAutonext: e.target.checked })} /> Play the next video automatically
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={onTop}
                      onChange={(e) => {
                        setOnTop(e.target.checked)
                        getCurrentWindow().setAlwaysOnTop(e.target.checked)
                      }}
                    />{' '}
                    <Pin size={14} /> Always on top
                  </label>
                  <button className="btn" onClick={jump}>
                    Jump to time… (Ctrl+G)
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

function Slider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
    </label>
  )
}
