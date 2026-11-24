import { useEffect, useRef, useState } from 'react'
import { Camera, Cloud, FolderOpen, MapPin, Pencil, Star, Tag, X } from 'lucide-react'
import { api, errText, fmtDate, fmtSize, nameOf, SOURCE_LABEL, thumbUrl, type Info, type UserMeta } from '../api'
import { toast } from '../store'
import { renameItem } from '../actions'

const cache = new Map<string, Info>()

export function InfoPanel({ path, onClose }: { path: string; onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(cache.get(path) ?? null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setErr(null)
    const c = cache.get(path)
    setInfo(c ?? null)
    if (!c)
      api
        .info(path)
        .then((i) => {
          if (cache.size > 200) cache.clear()
          cache.set(path, i)
          if (live) setInfo(i)
        })
        .catch((e) => live && setErr(String(e)))
    return () => {
      live = false
    }
  }, [path])

  return (
    <aside className="info-panel glass" onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <h3>Info</h3>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close info">
          <X size={16} />
        </button>
      </header>
      {err && <p className="muted">{err}</p>}
      {!info && !err && <div className="spinner small" />}
      {info && (
        <div className="info-body">
          <button className="info-name" onClick={() => renameItem(path).then(() => cache.delete(path))} title="Rename">
            <span>{nameOf(info.path)}</span>
            <Pencil size={13} />
          </button>
          <div className="info-date">{fmtDate(info.taken ?? info.mtime, { dateStyle: 'full', timeStyle: 'short' })}</div>

          <div className="chips">
            <span className="chip">{info.ext.toUpperCase()}</span>
            {info.width && info.height && (
              <span className="chip">
                {info.width} × {info.height}
              </span>
            )}
            {info.width && info.height && info.kind !== 1 && (
              <span className="chip">{((info.width * info.height) / 1e6).toFixed(1)} MP</span>
            )}
            <span className="chip">{fmtSize(info.size)}</span>
            {info.source && <span className="chip accent">{SOURCE_LABEL[info.source] ?? info.source}</span>}
            {info.cloud && (
              <span className="chip">
                <Cloud size={12} /> Online-only
              </span>
            )}
          </div>

          {info.kind !== 1 && <UserMetaEditor path={path} />}
          {info.kind !== 1 && <Histogram path={path} />}

          {info.camera && (
            <section className="info-camera">
              <Camera size={16} />
              <div>
                <strong>{info.camera}</strong>
                <div className="muted">
                  {info.fields
                    .filter(([k]) => ['Aperture', 'Shutter', 'ISO', 'Focal length'].includes(k))
                    .map(([, v]) => v)
                    .join('  ·  ')}
                </div>
              </div>
            </section>
          )}

          {info.lat != null && info.lon != null && <MiniMap lat={info.lat} lon={info.lon} />}
          <DateLocation
            info={info}
            onChange={() => {
              cache.delete(path)
              api.info(path).then(setInfo)
            }}
          />

          <dl className="info-list">
            {info.taken && (
              <>
                <dt>Taken</dt>
                <dd>{fmtDate(info.taken)}</dd>
              </>
            )}
            <dt>Modified</dt>
            <dd>{fmtDate(info.mtime)}</dd>
            <dt>Added</dt>
            <dd>{fmtDate(info.ctime)}</dd>
            {info.fields
              .filter(([k]) => !['Aperture', 'Shutter', 'ISO', 'Focal length'].includes(k) || !info.camera)
              .map(([k, v]) => (
                <Row key={k} k={k} v={v} />
              ))}
          </dl>

          <button className="info-path" onClick={() => api.reveal(path)} title="Show in Explorer">
            <FolderOpen size={15} />
            <span>{info.folder}</span>
          </button>
        </div>
      )}
    </aside>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  )
}

/** A light map: OpenStreetMap tiles positioned around the pin, no map library needed. */
function MiniMap({ lat, lon }: { lat: number; lon: number }) {
  const z = 14
  const W = 300
  const H = 150
  const n = 2 ** z
  const px = ((lon + 180) / 360) * n * 256
  const latR = (lat * Math.PI) / 180
  const py = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n * 256
  const x0 = px - W / 2
  const y0 = py - H / 2
  const tiles = []
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W) / 256); tx++)
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + H) / 256); ty++)
      tiles.push(
        <img
          key={`${tx},${ty}`}
          src={`https://tile.openstreetmap.org/${z}/${((tx % n) + n) % n}/${ty}.png`}
          style={{ left: tx * 256 - x0, top: ty * 256 - y0 }}
          alt=""
          draggable={false}
        />,
      )
  const coords = `${lat.toFixed(5)}, ${lon.toFixed(5)}`
  return (
    <section className="mini-map">
      <div className="mini-map-tiles" style={{ width: W, height: H }}>
        {tiles}
        <MapPin className="mini-map-pin" size={26} fill="currentColor" />
      </div>
      <div className="mini-map-actions">
        <span className="muted">{coords}</span>
        <button className="link-btn" onClick={() => api.openExternal(`https://www.google.com/maps?q=${lat},${lon}`)}>
          Google Maps
        </button>
        <button
          className="link-btn"
          onClick={() => api.openExternal(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`)}
        >
          OSM
        </button>
      </div>
    </section>
  )
}

// ------------------------------------------------------- rating, tags, notes

let tagCache: string[] | null = null

function UserMetaEditor({ path }: { path: string }) {
  const [m, setM] = useState<UserMeta | null>(null)
  const [tagInput, setTagInput] = useState('')
  const [allTags, setAllTags] = useState<string[]>(tagCache ?? [])
  const descTimer = useRef<number>(undefined)

  useEffect(() => {
    api.userMeta(path).then(setM)
    if (!tagCache) api.allTags().then((t) => setAllTags((tagCache = t.map((x) => x[0]))))
  }, [path])

  if (!m) return null
  const save = (p: Partial<UserMeta>) => {
    const next = { ...m, ...p }
    setM(next)
    api.setUserMeta([path], p).catch((e) => toast(errText(e)))
    if (p.tags) tagCache = null
  }
  const addTag = (t: string) => {
    const v = t.trim()
    if (!v || m.tags.some((x) => x.toLowerCase() === v.toLowerCase())) return setTagInput('')
    save({ tags: [...m.tags, v] })
    setTagInput('')
  }
  const suggestions = tagInput
    ? allTags.filter((t) => t.toLowerCase().startsWith(tagInput.toLowerCase()) && !m.tags.includes(t)).slice(0, 5)
    : []

  return (
    <section className="meta-edit">
      <div className="stars" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => save({ rating: m.rating === n ? 0 : n })} aria-label={`${n} stars`}>
            <Star size={17} fill={n <= m.rating ? 'currentColor' : 'none'} className={n <= m.rating ? 'on' : ''} />
          </button>
        ))}
      </div>
      <textarea
        className="field note"
        placeholder="Add a description…"
        defaultValue={m.description}
        key={path}
        rows={2}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const v = e.target.value
          clearTimeout(descTimer.current)
          descTimer.current = window.setTimeout(() => save({ description: v }), 500)
        }}
      />
      <div className="tags">
        {m.tags.map((t) => (
          <span key={t} className="tag">
            <Tag size={11} /> {t}
            <button onClick={() => save({ tags: m.tags.filter((x) => x !== t) })} aria-label={`Remove ${t}`}>
              <X size={11} />
            </button>
          </span>
        ))}
        <div className="tag-input">
          <input
            className="field sm"
            placeholder="Add tag"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                addTag(tagInput)
              }
            }}
          />
          {suggestions.length > 0 && (
            <div className="tag-suggest glass">
              {suggestions.map((sg) => (
                <button
                  key={sg}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    addTag(sg)
                  }}
                >
                  {sg}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function toLocalInput(ms: number) {
  const d = new Date(ms)
  const z = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`
}

function DateLocation({ info, onChange }: { info: Info; onChange: () => void }) {
  const [editing, setEditing] = useState<'date' | 'loc' | null>(null)
  const [val, setVal] = useState('')
  const start = (what: 'date' | 'loc') => {
    setEditing(what)
    setVal(what === 'date' ? toLocalInput(info.taken ?? info.mtime) : info.lat != null ? `${info.lat}, ${info.lon}` : '')
  }
  const commit = async () => {
    try {
      if (editing === 'date') {
        const ms = new Date(val).getTime()
        if (isNaN(ms)) return toast('Invalid date')
        const n = await api.setTaken([info.path], ms)
        toast(n ? 'Date taken saved into the file' : 'Date saved in the library (this format has no lossless date field)')
      } else {
        if (!val.trim()) {
          await api.setLocation([info.path], null, null)
        } else {
          const m = val.match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/)
          if (!m) return toast('Paste coordinates like 35.6892, 51.3890')
          await api.setLocation([info.path], +m[1], +m[2])
        }
        toast('Location saved')
      }
      setEditing(null)
      onChange()
    } catch (e) {
      toast(errText(e))
    }
  }
  if (editing)
    return (
      <form
        className="edit-row"
        onSubmit={(e) => {
          e.preventDefault()
          commit()
        }}
      >
        <input
          className="field sm"
          type={editing === 'date' ? 'datetime-local' : 'text'}
          value={val}
          autoFocus
          placeholder="lat, lon (empty = remove)"
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button className="btn sm primary" type="submit">
          Save
        </button>
        <button className="btn sm" type="button" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </form>
    )
  return (
    <div className="row">
      <button className="link-btn" onClick={() => start('date')}>
        Edit date taken
      </button>
      <button className="link-btn" onClick={() => start('loc')}>
        {info.lat != null ? 'Edit location' : 'Add location'}
      </button>
    </div>
  )
}

/** RGB histogram from the cached thumbnail (cheap, no full decode). */
function Histogram({ path }: { path: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const im = new Image()
    im.crossOrigin = 'anonymous'
    im.onload = () => {
      const c = document.createElement('canvas')
      c.width = im.naturalWidth
      c.height = im.naturalHeight
      const x = c.getContext('2d', { willReadFrequently: true })!
      x.drawImage(im, 0, 0)
      const d = x.getImageData(0, 0, c.width, c.height).data
      const bins = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)]
      for (let i = 0; i < d.length; i += 4) {
        bins[0][d[i] >> 2]++
        bins[1][d[i + 1] >> 2]++
        bins[2][d[i + 2] >> 2]++
      }
      const out = ref.current
      if (!out) return
      const g = out.getContext('2d')!
      const W = (out.width = 300)
      const H = (out.height = 70)
      const max = Math.max(1, ...bins.flatMap((b) => Array.from(b).slice(1, 63)))
      g.globalCompositeOperation = 'lighter'
      const cols = ['rgba(255,70,70,0.7)', 'rgba(70,220,110,0.7)', 'rgba(70,140,255,0.7)']
      cols.forEach((col, ci) => {
        g.fillStyle = col
        g.beginPath()
        g.moveTo(0, H)
        bins[ci].forEach((v, i) => g.lineTo((i / 63) * W, H - Math.min(1, v / max) * H))
        g.lineTo(W, H)
        g.fill()
      })
    }
    im.src = thumbUrl(path, 320)
  }, [path])
  return <canvas className="histogram" ref={ref} />
}
