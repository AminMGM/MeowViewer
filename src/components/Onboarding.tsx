import { useEffect, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { ArrowLeft, ArrowRight, Check, Cloud, Download, FolderPlus, Heart, Monitor, Moon, ScanText, Sun } from 'lucide-react'
import { api, errText, type Settings } from '../api'
import { toast, useStore } from '../store'
import { ACCENTS } from '../views/SettingsView'
import { Logo } from './Logo'
import { Toggle } from './ui'

export const GITHUB = 'https://github.com/AminMGM'

export function MadeBy() {
  return (
    <button className="made-by" onClick={() => api.openExternal(GITHUB)} title={GITHUB}>
      Made with <Heart size={12} fill="currentColor" className="heart" /> by <strong>AminMGM</strong>
    </button>
  )
}

const STEPS = ['Welcome', 'Look', 'Library', 'Extras', 'Done'] as const

export function Onboarding() {
  const settings = useStore((s) => s.settings)!
  const patch = useStore((s) => s.patchSettings)
  const [step, setStep] = useState(0)
  const [clouds, setClouds] = useState<[string, string][]>([])
  const [codecs, setCodecs] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [pct, setPct] = useState<number | null>(null)

  useEffect(() => {
    api.cloudFolders().then(setClouds)
    api.codecsInstalled().then(setInstalled)
    const un = listen<{ pct: number }>('codecs-progress', (e) => setPct(e.payload.pct))
    return () => void un.then((f) => f())
  }, [])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => patch({ [k]: v } as Partial<Settings>)
  const toggleRoot = (p: string, on: boolean) =>
    set('roots', on ? [...settings.roots.filter((r) => r !== p), p] : settings.roots.filter((r) => r !== p))

  const finish = async () => {
    patch({ onboarded: true })
    if (codecs && !installed) {
      toast('Downloading video codecs in the background…')
      api.installCodecs().then(
        () => toast('Video codecs installed'),
        (e) => toast(errText(e)),
      )
    }
    api.ocrControl(settings.ocr)
    api.rescan()
  }

  const allFolders = Array.from(new Set([...settings.roots, ...clouds.map(([, p]) => p)]))

  return (
    <div className="onboard-backdrop">
      <div className="onboard glass">
        <div className="onboard-steps">
          {STEPS.map((s, i) => (
            <span key={s} className={i === step ? 'on' : i < step ? 'done' : ''} />
          ))}
        </div>

        {step === 0 && (
          <div className="onboard-page center">
            <div className="onboard-logo">
              <Logo size={88} />
            </div>
            <h1>Welcome to MeowViewer</h1>
            <p className="muted">
              A fast photo &amp; video viewer and gallery. Let's set a few things up — it takes less than a minute, and you can
              change everything later in Settings.
            </p>
            <MadeBy />
          </div>
        )}

        {step === 1 && (
          <div className="onboard-page">
            <h2>Choose your look</h2>
            <div className="theme-cards">
              {(
                [
                  ['system', 'System', <Monitor size={18} key="m" />],
                  ['light', 'Light', <Sun size={18} key="s" />],
                  ['dark', 'Dark', <Moon size={18} key="d" />],
                ] as const
              ).map(([id, label, icon]) => (
                <button key={id} className={`theme-card ${id}${settings.theme === id ? ' on' : ''}`} onClick={() => set('theme', id)}>
                  <div className="theme-preview">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="theme-label">
                    {icon} {label}
                  </div>
                </button>
              ))}
            </div>
            <h3>Accent colour</h3>
            <div className="accents big">
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
          </div>
        )}

        {step === 2 && (
          <div className="onboard-page">
            <h2>Which folders are your library?</h2>
            <p className="muted">Photos and videos in these folders (and their subfolders) appear in your gallery.</p>
            <div className="onboard-folders">
              {allFolders.map((p) => {
                const cloud = clouds.find(([, c]) => c === p)
                return (
                  <label key={p} className="onboard-folder">
                    <input type="checkbox" checked={settings.roots.includes(p)} onChange={(e) => toggleRoot(p, e.target.checked)} />
                    {cloud ? <Cloud size={16} /> : <Check size={16} className="muted" />}
                    <span title={p}>
                      {cloud && <strong>{cloud[0]} — </strong>}
                      {p}
                    </span>
                  </label>
                )
              })}
            </div>
            <button
              className="btn"
              onClick={async () => {
                const d = await openDialog({ directory: true, multiple: true, title: 'Add folders' })
                if (!d) return
                const list = Array.isArray(d) ? d : [d]
                set('roots', [...settings.roots, ...list.filter((x) => !settings.roots.includes(x))])
              }}
            >
              <FolderPlus size={15} /> Add another folder
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="onboard-page">
            <h2>Optional extras</h2>
            <div className="onboard-option">
              <Download size={20} />
              <div>
                <strong>Video codec pack</strong>
                <p className="muted">
                  Plays AVI, WMV, MPEG, TS, FLV and every other format; enables embedded subtitles and audio tracks. About 90 MB,
                  downloaded once.
                </p>
                {pct != null && pct < 100 && (
                  <div className="vp-progress">
                    <span style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              {installed ? <span className="chip accent">Installed</span> : <Toggle on={codecs} onChange={setCodecs} />}
            </div>
            <div className="onboard-option">
              <ScanText size={20} />
              <div>
                <strong>Search text inside photos</strong>
                <p className="muted">Reads text in screenshots and documents on this PC (offline) so search can find it. Runs quietly in the background.</p>
              </div>
              <Toggle on={settings.ocr} onChange={(v) => set('ocr', v)} />
            </div>
            <div className="onboard-option">
              <Download size={20} />
              <div>
                <strong>Automatic updates</strong>
                <p className="muted">Checks GitHub for new versions and offers to install them.</p>
              </div>
              <Toggle on={settings.autoUpdate} onChange={(v) => set('autoUpdate', v)} />
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="onboard-page center">
            <div className="onboard-logo">
              <Logo size={64} />
            </div>
            <h2>You're all set</h2>
            <p className="muted">Want photos and videos to open in MeowViewer when you double-click them?</p>
            <button className="btn" onClick={() => api.openExternal('ms-settings:defaultapps')}>
              Make MeowViewer the default app
            </button>
            <p className="muted small">In Windows Settings, search for MeowViewer and choose it for the file types you like.</p>
            <MadeBy />
          </div>
        )}

        <div className="onboard-nav">
          {step > 0 ? (
            <button className="btn" onClick={() => setStep(step - 1)}>
              <ArrowLeft size={15} /> Back
            </button>
          ) : (
            <button className="link-btn" onClick={finish}>
              Skip setup
            </button>
          )}
          <span className="spacer" />
          {step < STEPS.length - 1 ? (
            <button className="btn primary" onClick={() => setStep(step + 1)}>
              {step === 0 ? "Let's go" : 'Next'} <ArrowRight size={15} />
            </button>
          ) : (
            <button className="btn primary" onClick={finish}>
              Start using MeowViewer
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
