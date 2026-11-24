import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { FileOutput, FolderOpen, X } from 'lucide-react'
import { api, errText, nameOf } from '../api'
import { toast, useStore } from '../store'

const FORMATS: { id: string; label: string; desc: string }[] = [
  { id: 'jpg', label: 'JPEG', desc: 'Smallest, works everywhere' },
  { id: 'png', label: 'PNG', desc: 'Lossless, keeps transparency' },
  { id: 'webp', label: 'WebP', desc: 'Lossless, modern web' },
  { id: 'tiff', label: 'TIFF', desc: 'Lossless, for print & editing' },
  { id: 'bmp', label: 'BMP', desc: 'Uncompressed' },
  { id: 'gif', label: 'GIF', desc: '256 colours' },
]
const SIZES: [number, string][] = [
  [0, 'Original size'],
  [3840, '4K (3840 px)'],
  [2048, 'Large (2048 px)'],
  [1080, 'Social (1080 px)'],
  [640, 'Small (640 px)'],
]

const useExport = create<{ paths: string[] | null }>(() => ({ paths: null }))
export const openExport = (paths: string[]) => useExport.setState({ paths })

const PREF_KEY = 'mv-export'
const loadPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<{ format: string; size: number; quality: number; dest: string }>
  } catch {
    return {}
  }
}

export function ExportDialog() {
  const paths = useExport((s) => s.paths)
  const roots = useStore((s) => s.settings?.roots ?? [])
  const prefs = loadPrefs()
  const [format, setFormat] = useState(prefs.format ?? 'jpg')
  const [size, setSize] = useState(prefs.size ?? 0)
  const [quality, setQuality] = useState(prefs.quality ?? 90)
  const [dest, setDest] = useState(prefs.dest ?? '')
  const [keepDates, setKeepDates] = useState(true)
  const [done, setDone] = useState<number | null>(null)

  useEffect(() => {
    const un = listen<number>('export-progress', (e) => setDone(e.payload))
    return () => void un.then((f) => f())
  }, [])

  if (!paths) return null
  const close = () => {
    useExport.setState({ paths: null })
    setDone(null)
  }
  const destinations: [string, string][] = [
    ['', 'Next to the originals (a “Converted” folder)'],
    ...roots.map((r): [string, string] => [`${r}\\MeowViewer Exports`, `${nameOf(r)} › MeowViewer Exports`]),
  ]
  if (dest && !destinations.some(([d]) => d === dest)) destinations.push([dest, dest])

  const run = async () => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ format, size, quality, dest }))
    } catch {
      /* ignore */
    }
    setDone(0)
    try {
      const n = await api.exportImages(paths, dest, format, size, quality, keepDates)
      close()
      toast(`${n} ${n === 1 ? 'image' : 'images'} exported as ${format.toUpperCase()} (location data removed)`, {
        label: 'Open folder',
        run: () => api.openExternal(dest || paths[0].slice(0, paths[0].lastIndexOf('\\')) + '\\Converted'),
      })
    } catch (e) {
      setDone(null)
      close()
      toast(errText(e))
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done == null && close()}>
      <div className="modal export glass">
        <header className="export-head">
          <FileOutput size={18} />
          <h3>
            Export {paths.length} {paths.length === 1 ? 'item' : 'items'}
          </h3>
          <span className="spacer" />
          <button className="icon-btn sm" onClick={close} disabled={done != null}>
            <X size={16} />
          </button>
        </header>

        <label className="export-label">Format</label>
        <div className="format-grid">
          {FORMATS.map((f) => (
            <button key={f.id} className={`format${format === f.id ? ' on' : ''}`} onClick={() => setFormat(f.id)}>
              <strong>{f.label}</strong>
              <span>{f.desc}</span>
            </button>
          ))}
        </div>

        <div className="export-row">
          <div>
            <label className="export-label">Size (longest side)</label>
            <select className="field" value={size} onChange={(e) => setSize(+e.target.value)}>
              {SIZES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          {format === 'jpg' && (
            <div>
              <label className="export-label">Quality · {quality}</label>
              <input type="range" min={40} max={100} value={quality} onChange={(e) => setQuality(+e.target.value)} />
            </div>
          )}
        </div>

        <label className="export-label">Save to</label>
        <div className="dest-list">
          {destinations.map(([d, label]) => (
            <button key={d || 'next'} className={`dest${dest === d ? ' on' : ''}`} onClick={() => setDest(d)} title={d}>
              <FolderOpen size={15} />
              <span>{label}</span>
            </button>
          ))}
          <button
            className="dest"
            onClick={async () => {
              const d = await openDialog({ directory: true, title: 'Export to folder' })
              if (d && !Array.isArray(d)) setDest(d)
            }}
          >
            <FolderOpen size={15} />
            <span>Another folder…</span>
          </button>
        </div>

        <label className="check">
          <input type="checkbox" checked={keepDates} onChange={(e) => setKeepDates(e.target.checked)} /> Keep original file dates
        </label>

        {done != null && (
          <div className="vp-progress">
            <span style={{ width: `${(done / paths.length) * 100}%` }} />
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={() => (done != null ? api.cancelTask('export') : close())}>
            {done != null ? 'Stop export' : 'Cancel'}
          </button>
          <button className="btn primary" onClick={run} disabled={done != null}>
            {done != null ? `Exporting ${done}/${paths.length}…` : 'Export'}
          </button>
        </div>
      </div>
    </div>
  )
}
