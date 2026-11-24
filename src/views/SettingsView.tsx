import { useEffect, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { Cloud, Download, Eye, FolderPlus, RefreshCw, Trash2 } from 'lucide-react'
import { api, errText, fmtSize, type Settings } from '../api'
import { toast, useStore } from '../store'
import { Toggle } from '../components/ui'
import { checkForUpdate } from '../updater'
import { MadeBy } from '../components/Onboarding'

export const ACCENTS: Record<string, [string, string]> = {
  aurora: ['#8b5cf6', '#22d3ee'],
  sunset: ['#f97316', '#ec4899'],
  ocean: ['#3b82f6', '#06b6d4'],
  mint: ['#10b981', '#a3e635'],
  rose: ['#f43f5e', '#a855f7'],
  gold: ['#f59e0b', '#fde047'],
  mono: ['#e4e4e7', '#a1a1aa'],
}

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        {desc && <div className="set-desc">{desc}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function SettingsView() {
  const settings = useStore((s) => s.settings)!
  const libVersion = useStore((s) => s.libVersion)
  const patch = useStore((s) => s.patchSettings)
  const [hidden, setHidden] = useState<string[]>([])
  const [cache, setCache] = useState<number | null>(null)
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [ocr, setOcr] = useState<{ running: boolean; done: number; total: number } | null>(null)
  const [codecs, setCodecs] = useState<boolean | null>(null)
  const [codecPct, setCodecPct] = useState<number | null>(null)
  const [clouds, setClouds] = useState<[string, string][]>([])

  useEffect(() => {
    api.ocrProgress().then(setOcr)
    api.codecsInstalled().then(setCodecs)
    api.cloudFolders().then(setClouds)
    const subs = [
      listen<{ running: boolean; done: number; total: number }>('ocr-progress', (e) => setOcr(e.payload)),
      listen<{ stage: string; pct: number }>('codecs-progress', (e) => setCodecPct(e.payload.pct)),
    ]
    return () => subs.forEach((u) => u.then((f) => f()))
  }, [])

  useEffect(() => {
    api.hiddenFolders().then(setHidden)
  }, [libVersion])
  useEffect(() => {
    api.cacheInfo().then(setCache)
    getVersion().then(setVersion)
  }, [])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => patch({ [k]: v } as Partial<Settings>)

  const addRoot = async () => {
    const dir = await openDialog({ directory: true, multiple: true, title: 'Add folders to your library' })
    if (!dir) return
    const list = (Array.isArray(dir) ? dir : [dir]).filter((d) => !settings.roots.includes(d))
    if (list.length) set('roots', [...settings.roots, ...list])
  }

  return (
    <div className="grid-scroll">
      <div className="settings">
        <h1>Settings</h1>

        <section className="set-card glass">
          <h2>Library</h2>
          <p className="set-desc">Folders shown in Photos and Albums. Subfolders are included automatically.</p>
          <div className="roots">
            {settings.roots.map((r) => (
              <div key={r} className="root">
                <span title={r}>{r}</span>
                <button className="icon-btn sm" onClick={() => api.openExternal(r)} title="Open">
                  <Eye size={15} />
                </button>
                <button
                  className="icon-btn sm danger"
                  onClick={() => set('roots', settings.roots.filter((x) => x !== r))}
                  title="Remove from library (files are not deleted)"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
          <div className="row">
            <button className="btn" onClick={addRoot}>
              <FolderPlus size={15} /> Add folder
            </button>
            <button className="btn" onClick={() => api.rescan().then(() => toast('Rescanning library…'))}>
              <RefreshCw size={15} /> Rescan
            </button>
          </div>
        </section>

        {clouds.length > 0 && (
          <section className="set-card glass">
            <h2>Cloud folders</h2>
            <p className="set-desc">
              OneDrive and Google Drive (desktop apps) sync into these folders. Online-only files show thumbnails without
              downloading.
            </p>
            <div className="roots">
              {clouds.map(([name, path]) => {
                const added = settings.roots.some((r) => r.toLowerCase() === path.toLowerCase())
                return (
                  <div key={path} className="root">
                    <Cloud size={15} />
                    <span title={path}>
                      <strong>{name}</strong> — {path}
                    </span>
                    <button className="btn sm" disabled={added} onClick={() => set('roots', [...settings.roots, path])}>
                      {added ? 'In library' : 'Add to library'}
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        <section className="set-card glass">
          <h2>Search</h2>
          <Row
            title="Find text inside photos"
            desc="Reads text in screenshots, documents and signs on this PC (Windows OCR, offline) so search can find it."
          >
            <Toggle
              on={settings.ocr}
              onChange={(v) => {
                set('ocr', v)
                api.ocrControl(v)
              }}
            />
          </Row>
          {ocr && ocr.total > 0 && (
            <Row title={ocr.running ? 'Reading photos…' : 'Text index'} desc={`${ocr.done.toLocaleString()} of ${ocr.total.toLocaleString()} photos read`}>
              <div className="row center">
                <div className="vp-progress inline">
                  <span style={{ width: `${(ocr.done / Math.max(1, ocr.total)) * 100}%` }} />
                </div>
                {ocr.running ? (
                  <button className="btn sm" onClick={() => api.cancelTask('ocr')}>
                    Pause
                  </button>
                ) : (
                  ocr.done < ocr.total && settings.ocr && (
                    <button className="btn sm" onClick={() => api.ocrControl(true)}>
                      Resume
                    </button>
                  )
                )}
              </div>
            </Row>
          )}
        </section>

        <section className="set-card glass">
          <h2>Hidden folders</h2>
          {hidden.length === 0 ? (
            <p className="set-desc">Right-click a folder in Albums → Hide folder to keep it out of Photos, search and albums.</p>
          ) : (
            <div className="roots">
              {hidden.map((h) => (
                <div key={h} className="root">
                  <span title={h}>{h}</span>
                  <button className="btn sm" onClick={() => api.setFolderHidden(h, false)}>
                    Unhide
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="set-card glass">
          <h2>Appearance</h2>
          <Row title="Accent">
            <div className="accents">
              {Object.entries(ACCENTS).map(([k, [a, b]]) => (
                <button
                  key={k}
                  className={`accent-dot${settings.accent === k ? ' on' : ''}`}
                  style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}
                  onClick={() => set('accent', k)}
                  title={k}
                />
              ))}
            </div>
          </Row>
          <Row title="Theme">
            <Seg
              value={settings.theme}
              options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]}
              onChange={(v) => set('theme', v)}
            />
          </Row>
          <Row title="Viewer background" desc="Ambient blurs the photo's own colours behind it.">
            <Seg value={settings.viewerBg} options={[['ambient', 'Ambient'], ['dark', 'Dark'], ['black', 'Black']]} onChange={(v) => set('viewerBg', v)} />
          </Row>
          <Row title="Thumbnail size" desc="Ctrl + mouse wheel in any grid also works.">
            <input type="range" min={90} max={380} value={settings.gridSize} onChange={(e) => set('gridSize', +e.target.value)} />
          </Row>
        </section>

        <section className="set-card glass">
          <h2>Viewer</h2>
          <Row title="Mouse wheel" desc="Ctrl + wheel always zooms.">
            <Seg value={settings.wheel} options={[['zoom', 'Zoom'], ['navigate', 'Next / previous']]} onChange={(v) => set('wheel', v)} />
          </Row>
          <Row title="Filmstrip">
            <Toggle on={settings.filmstrip} onChange={(v) => set('filmstrip', v)} />
          </Row>
          <Row title="Slideshow interval">
            <Seg
              value={String(settings.slideshowSecs)}
              options={[['2', '2 s'], ['4', '4 s'], ['7', '7 s'], ['12', '12 s']]}
              onChange={(v) => set('slideshowSecs', +v)}
            />
          </Row>
          <Row title="Shuffle slideshows">
            <Toggle on={settings.slideshowShuffle} onChange={(v) => set('slideshowShuffle', v)} />
          </Row>
          <Row
            title="Video codecs"
            desc={
              codecs
                ? 'Installed — AVI, WMV, MPEG, TS, FLV and other formats are converted on the fly.'
                : 'MP4, MOV, WebM and MKV play natively. Install FFmpeg (about 90 MB, once) to play every other format.'
            }
          >
            {codecs ? (
              <span className="chip accent">Installed</span>
            ) : codecPct != null ? (
              <div className="row center">
                <div className="vp-progress inline">
                  <span style={{ width: `${codecPct}%` }} />
                </div>
                <button className="btn sm" onClick={() => api.cancelTask('codecs')}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="btn"
                onClick={async () => {
                  setCodecPct(0)
                  try {
                    await api.installCodecs()
                    setCodecs(true)
                    toast('Video codecs installed')
                  } catch (e) {
                    toast(errText(e))
                  }
                  setCodecPct(null)
                }}
              >
                <Download size={15} /> Install
              </button>
            )}
          </Row>
          <Row title="Default app" desc="Make MeowViewer open your photos and videos.">
            <button className="btn" onClick={() => api.openExternal('ms-settings:defaultapps?registeredAppMachine=MeowViewer')}>
              Open Windows settings
            </button>
          </Row>
        </section>

        <section className="set-card glass">
          <h2>Private album</h2>
          <Row title="Lock automatically after" desc="It also locks when you leave the Private page or minimise the window.">
            <Seg
              value={String(settings.vaultAutolockMin)}
              options={[['1', '1 min'], ['5', '5 min'], ['15', '15 min']]}
              onChange={(v) => set('vaultAutolockMin', +v)}
            />
          </Row>
        </section>

        <section className="set-card glass">
          <h2>Storage</h2>
          <Row title="Keep deleted items for">
            <Seg
              value={String(settings.trashDays)}
              options={[['7', '7 days'], ['30', '30 days'], ['90', '90 days']]}
              onChange={(v) => set('trashDays', +v)}
            />
          </Row>
          <Row title="Thumbnail cache" desc={cache == null ? '' : `${fmtSize(cache)} — rebuilt automatically when needed`}>
            <button
              className="btn"
              onClick={() =>
                api.clearCache().then(() => {
                  setCache(0)
                  toast('Cache cleared')
                }, (e) => toast(errText(e)))
              }
            >
              Clear
            </button>
          </Row>
        </section>

        <section className="set-card glass">
          <h2>Updates</h2>
          <Row title={`MeowViewer ${version}`} desc="Updates are downloaded from github.com/AminMGM/MeowViewer">
            <button
              className="btn"
              disabled={checking}
              onClick={async () => {
                setChecking(true)
                await checkForUpdate(true)
                setChecking(false)
              }}
            >
              <RefreshCw size={15} className={checking ? 'spin' : ''} /> Check now
            </button>
          </Row>
          <Row title="Check automatically">
            <Toggle on={settings.autoUpdate} onChange={(v) => set('autoUpdate', v)} />
          </Row>
        </section>

        <section className="set-card glass about">
          <h2>About</h2>
          <Row title={`MeowViewer ${version}`} desc="A fast, light photo & video viewer and gallery for Windows. MIT licence.">
            <button className="btn" onClick={() => patch({ onboarded: false })}>
              Run setup again
            </button>
          </Row>
          <div className="row center">
            <MadeBy />
            <span className="spacer" />
            <button className="link-btn" onClick={() => api.openExternal('https://github.com/AminMGM/MeowViewer')}>
              Source code &amp; releases
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
