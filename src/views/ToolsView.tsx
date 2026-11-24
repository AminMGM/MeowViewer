import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Copy, HardDrive, Layers, MonitorSmartphone, Scan, Sparkles, Trash2, Video } from 'lucide-react'
import { api, errText, fmtSize, I, KIND, nameOf, SOURCE_LABEL, thumbUrl, type DupGroup, type Item, type Stats } from '../api'
import { toast, useStore } from '../store'
import { moveToTrash } from '../actions'
import { MediaGrid } from '../components/MediaGrid'

const KIND_LABEL = ['Photos', 'Videos', 'GIFs', 'RAW']

export function ToolsView() {
  const libVersion = useStore((s) => s.libVersion)
  const [stats, setStats] = useState<Stats | null>(null)
  const [tab, setTab] = useState<'overview' | 'dups' | 'shots' | 'large'>('overview')
  const [drives, setDrives] = useState<string[]>([])

  useEffect(() => {
    api.stats().then(setStats, (e) => toast(errText(e)))
    api.removableDrives().then(setDrives)
  }, [libVersion])

  return (
    <div className="grid-wrap">
      <div className="tools-tabs">
        <h1>Cleanup</h1>
        <div className="segmented">
          <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>
            <HardDrive size={15} /> Storage
          </button>
          <button className={tab === 'dups' ? 'on' : ''} onClick={() => setTab('dups')}>
            <Copy size={15} /> Duplicates
          </button>
          <button className={tab === 'shots' ? 'on' : ''} onClick={() => setTab('shots')}>
            <Scan size={15} /> Old screenshots
          </button>
          <button className={tab === 'large' ? 'on' : ''} onClick={() => setTab('large')}>
            <Video size={15} /> Large files
          </button>
        </div>
      </div>
      <div className="tools-body">
        {tab === 'overview' && <Overview stats={stats} drives={drives} onTab={setTab} />}
        {tab === 'dups' && <Duplicates />}
        {tab === 'shots' && <OldScreenshots />}
        {tab === 'large' && <LargeFiles />}
      </div>
    </div>
  )
}

function Overview({ stats, drives, onTab }: { stats: Stats | null; drives: string[]; onTab: (t: 'dups' | 'shots' | 'large') => void }) {
  const [importing, setImporting] = useState<number | null>(null)
  useEffect(() => {
    const un = listen<number>('import-progress', (e) => setImporting(e.payload))
    return () => void un.then((f) => f())
  }, [])
  if (!stats) return <div className="spinner small" />
  const max = Math.max(1, ...stats.byKind.map((k) => k[2]))
  return (
    <div className="grid-scroll">
      <div className="tools-cards">
        <section className="set-card glass">
          <h2>
            {stats.total.toLocaleString()} items · {fmtSize(stats.bytes)}
          </h2>
          <div className="bars">
            {stats.byKind.map(([k, n, b]) => (
              <div className="bar-row" key={k}>
                <span>{KIND_LABEL[k] ?? 'Other'}</span>
                <div className="bar">
                  <span style={{ width: `${(b / max) * 100}%` }} />
                </div>
                <span className="muted">
                  {n.toLocaleString()} · {fmtSize(b)}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="set-card glass">
          <h2>By app</h2>
          <div className="bars">
            {stats.bySource.slice(0, 8).map(([s, n, b]) => (
              <div className="bar-row" key={s}>
                <span>{SOURCE_LABEL[s] ?? s}</span>
                <div className="bar">
                  <span style={{ width: `${(b / (stats.bySource[0]?.[2] || 1)) * 100}%` }} />
                </div>
                <span className="muted">
                  {n.toLocaleString()} · {fmtSize(b)}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="set-card glass suggestion">
          <Copy size={20} />
          <div>
            <strong>Find duplicates</strong>
            <p className="set-desc">Exact copies and near-identical shots (bursts, re-saves, resized copies).</p>
          </div>
          <button className="btn" onClick={() => onTab('dups')}>
            Review
          </button>
        </section>
        {stats.oldScreenshots > 0 && (
          <section className="set-card glass suggestion">
            <Scan size={20} />
            <div>
              <strong>{stats.oldScreenshots.toLocaleString()} screenshots older than 6 months</strong>
              <p className="set-desc">{fmtSize(stats.oldScreenshotsBytes)} you could free up.</p>
            </div>
            <button className="btn" onClick={() => onTab('shots')}>
              Review
            </button>
          </section>
        )}
        <section className="set-card glass suggestion">
          <MonitorSmartphone size={20} />
          <div>
            <strong>Import from camera or SD card</strong>
            <p className="set-desc">
              {drives.length
                ? `Found ${drives.join(', ')}. New photos are copied to Pictures\\Imports by date; already-imported files are skipped.`
                : 'Insert a camera card or connect a phone in USB storage mode (a drive with a DCIM folder).'}
            </p>
            {importing != null && <p className="set-desc">{importing} copied…</p>}
          </div>
          {drives.map((d) => (
            <button
              key={d}
              className="btn"
              onClick={async () => {
                setImporting(0)
                try {
                  const n = await api.importFrom(d + 'DCIM')
                  toast(n ? `${n} new items imported` : 'Nothing new to import')
                } catch (e) {
                  toast(errText(e))
                }
                setImporting(null)
              }}
            >
              Import {d}
            </button>
          ))}
        </section>
      </div>
    </div>
  )
}

function Duplicates() {
  const [groups, setGroups] = useState<DupGroup[] | null>(null)
  const [progress, setProgress] = useState<[number, number] | null>(null)
  const [similar, setSimilar] = useState(true)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    const un = listen<[number, number]>('dup-progress', (e) => setProgress(e.payload))
    return () => void un.then((f) => f())
  }, [])

  const scan = async () => {
    setRunning(true)
    setGroups(null)
    try {
      setGroups(await api.duplicates(similar))
    } catch (e) {
      toast(errText(e))
    }
    setRunning(false)
    setProgress(null)
  }

  const keepBest = async (g: DupGroup) => {
    // Keep the first (newest/largest list order); trash the rest.
    await moveToTrash(g.paths.slice(1))
    setGroups((gs) => gs?.filter((x) => x !== g) ?? null)
  }

  const removable = groups?.reduce((a, g) => a + g.paths.length - 1, 0) ?? 0

  return (
    <div className="grid-scroll">
      <div className="tools-cards">
        <section className="set-card glass">
          <div className="row center">
            <label className="check">
              <input type="checkbox" checked={similar} onChange={(e) => setSimilar(e.target.checked)} /> Include similar photos
            </label>
            <span className="spacer" />
            <button className="btn primary" disabled={running} onClick={scan}>
              <Sparkles size={15} /> {running ? 'Scanning…' : groups ? 'Scan again' : 'Scan library'}
            </button>
          </div>
          {running && progress && (
            <div className="vp-progress">
              <span style={{ width: `${(progress[0] / Math.max(1, progress[1])) * 100}%` }} />
            </div>
          )}
          {groups && (
            <p className="set-desc">
              {groups.length} groups · {removable} extra copies
            </p>
          )}
        </section>
        {groups?.slice(0, 200).map((g, gi) => (
          <section key={gi} className="set-card glass dup-group">
            <div className="row center">
              <span className={`chip${g.kind === 'exact' ? ' accent' : ''}`}>{g.kind === 'exact' ? 'Exact copies' : 'Similar'}</span>
              <span className="muted">{fmtSize(g.size)}</span>
              <span className="spacer" />
              <button className="btn sm" onClick={() => keepBest(g)}>
                <Layers size={14} /> Keep first, trash {g.paths.length - 1}
              </button>
            </div>
            <div className="dup-row">
              {g.paths.map((p, i) => (
                <button
                  key={p}
                  className={`dup${i === 0 ? ' keep' : ''}`}
                  title={p}
                  onClick={() =>
                    useStore.getState().openViewer({
                      items: g.paths.map((x) => [0, x, 0, 0, false, 0, 0, 0] as Item),
                      index: i,
                      origin: 'gallery',
                    })
                  }
                >
                  <img src={thumbUrl(p, 320)} loading="lazy" alt="" />
                  <span>{nameOf(p)}</span>
                  {i > 0 && (
                    <span
                      className="dup-trash"
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        moveToTrash([p])
                        setGroups((gs) =>
                          gs
                            ?.map((x) => (x === g ? { ...x, paths: x.paths.filter((y) => y !== p) } : x))
                            .filter((x) => x.paths.length > 1) ?? null,
                        )
                      }}
                    >
                      <Trash2 size={13} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function OldScreenshots() {
  const libVersion = useStore((s) => s.libVersion)
  const [items, setItems] = useState<Item[]>([])
  useEffect(() => {
    api.oldScreenshots().then(setItems)
  }, [libVersion])
  const header = (
    <div className="view-head">
      <div className="title-row">
        <h1>Old screenshots</h1>
        <span className="count">
          {items.length} · {fmtSize(items.reduce((a, it) => a + it[I.size], 0))}
        </span>
        <span className="spacer" />
        {items.length > 0 && (
          <button className="btn danger" onClick={() => moveToTrash(items.map((it) => it[I.path]))}>
            <Trash2 size={15} /> Move all to Trash
          </button>
        )}
      </div>
      <p className="muted">Screenshots older than 6 months. Select the ones to keep out first, or move them all to Trash (restorable for 30 days).</p>
    </div>
  )
  return <MediaGrid items={items} group="month" header={header} />
}

function LargeFiles() {
  const libVersion = useStore((s) => s.libVersion)
  const [items, setItems] = useState<Item[]>([])
  useEffect(() => {
    api.query({ view: 'large', sort: 'size', desc: true }).then(setItems)
  }, [libVersion])
  const header = (
    <div className="view-head">
      <div className="title-row">
        <h1>Files over 50 MB</h1>
        <span className="count">
          {items.length} · {fmtSize(items.reduce((a, it) => a + it[I.size], 0))}
        </span>
      </div>
      <p className="muted">
        Mostly videos ({items.filter((it) => it[I.kind] === KIND.video).length}). Biggest first.
      </p>
    </div>
  )
  return <MediaGrid items={items} group="none" header={header} />
}
