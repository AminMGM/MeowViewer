import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import {
  Clock, Film, FolderHeart, Heart, Images, Lock, MapPin, PanelLeftClose, PanelLeftOpen, Search, Settings as Cog,
  Sparkles, Trash2, X,
} from 'lucide-react'
import { api, dirOf, I, nameOf, type Item, type Progress, type Startup } from './api'
import { useStore, type View } from './store'
import { DialogHost, MenuHost, Toasts } from './components/ui'
import { UnlockHost } from './components/PinPad'
import { ExportDialog } from './components/ExportDialog'
import { Onboarding } from './components/Onboarding'
import { Viewer, WindowButtons } from './viewer/Viewer'
import { LibraryView } from './views/LibraryView'
import { AlbumsView } from './views/AlbumsView'
import { TrashView } from './views/TrashView'
import { ACCENTS, SettingsView } from './views/SettingsView'
import { checkForUpdate } from './updater'
import { Logo } from './components/Logo'
import { PrivateView } from './views/PrivateView'
import { ToolsView } from './views/ToolsView'
import { Editor } from './editor/Editor'
import { Compare } from './viewer/Compare'
import { detectEditors, refreshAlbums } from './actions'

const MapView = lazy(() => import('./views/MapView'))

/** Resolves the theme setting against the OS and applies it to the page and the window's Mica. */
function useTheme(pref: 'system' | 'light' | 'dark' | undefined) {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const t = !pref || pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref
      document.documentElement.dataset.theme = t
      getCurrentWindow()
        .setTheme(pref === 'system' || !pref ? null : t)
        .catch(() => {})
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [pref])
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Opens a file in the viewer with its whole folder as the navigation list. */
async function openFile(path: string) {
  const { openViewer } = useStore.getState()
  // Show the file immediately, then fill in its neighbours.
  const single: Item = [0, path, 0, Date.now(), false, 0, 0, 0]
  const kindGuess = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|3gp|mts|m2ts|flv|mpg|mpeg|ts|ogv)$/i.test(path) ? 1 : 0
  single[I.kind] = kindGuess
  openViewer({ items: [single], index: 0, origin: 'file' })
  try {
    const items = await api.listDir(dirOf(path))
    items.sort((a, b) => collator.compare(nameOf(a[I.path]), nameOf(b[I.path])))
    const idx = items.findIndex((it) => it[I.path].toLowerCase() === path.toLowerCase())
    if (idx >= 0) {
      const cur = useStore.getState().viewer
      if (cur && cur.items.length === 1 && cur.items[0][I.path] === path) openViewer({ items, index: idx, origin: 'file' })
    }
  } catch {
    /* keep the single item */
  }
}

function handleStartup(st: Startup) {
  if (st.file) openFile(st.file)
  else if (st.folder) {
    useStore.getState().closeViewer()
    useStore.getState().go({ kind: 'folder', path: st.folder })
  }
}

const NAV: { view: View; label: string; icon: React.ReactNode }[] = [
  { view: { kind: 'photos' }, label: 'Photos', icon: <Images size={19} /> },
  { view: { kind: 'albums' }, label: 'Albums', icon: <FolderHeart size={19} /> },
  { view: { kind: 'videos' }, label: 'Videos', icon: <Film size={19} /> },
  { view: { kind: 'favorites' }, label: 'Favourites', icon: <Heart size={19} /> },
  { view: { kind: 'recent' }, label: 'Recent', icon: <Clock size={19} /> },
  { view: { kind: 'places' }, label: 'Places', icon: <MapPin size={19} /> },
  { view: { kind: 'private' }, label: 'Private', icon: <Lock size={19} /> },
  { view: { kind: 'tools' }, label: 'Cleanup', icon: <Sparkles size={19} /> },
  { view: { kind: 'trash' }, label: 'Trash', icon: <Trash2 size={19} /> },
]

export default function App() {
  const settings = useStore((s) => s.settings)
  const viewer = useStore((s) => s.viewer)
  const view = useStore((s) => s.view)
  const search = useStore((s) => s.search)
  const editing = useStore((s) => s.editing)
  const comparing = useStore((s) => s.compare)
  const { go, setSearch, patchSettings, bumpLibrary } = useStore.getState()
  const [progress, setProgress] = useState<Progress | null>(null)
  const [maximized, setMaximized] = useState(false)
  const [dropping, setDropping] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const shown = useRef(false)
  const scanning = useRef(false)
  useTheme(settings?.theme)

  // Boot: settings + startup file, then reveal the window (it starts hidden to avoid a white flash).
  useEffect(() => {
    ;(async () => {
      await useStore.getState().loadSettings()
      refreshAlbums()
      setTimeout(detectEditors, 1500)
      const st = await api.startup()
      handleStartup(st)
      requestAnimationFrame(() => {
        if (!shown.current) {
          shown.current = true
          getCurrentWindow().show()
          getCurrentWindow().setFocus()
        }
      })
    })()
  }, [])

  useEffect(() => {
    let timer: number | undefined
    const subs = [
      listen<Startup>('open-request', (e) => handleStartup(e.payload)),
      listen('library-changed', () => {
        // Coalesce bursts of changes. During a full scan refresh rarely, so the grid
        // doesn't keep shifting under the user while new photos are inserted.
        if (timer !== undefined && scanning.current) return
        clearTimeout(timer)
        timer = window.setTimeout(
          () => {
            timer = undefined
            bumpLibrary()
          },
          scanning.current ? 3000 : 250,
        )
      }),
      listen<Progress>('index-progress', (e) => {
        scanning.current = e.payload.scanning
        setProgress(e.payload)
      }),
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === 'over' || e.payload.type === 'enter') setDropping(true)
        else if (e.payload.type === 'leave') setDropping(false)
        else if (e.payload.type === 'drop') {
          setDropping(false)
          const p = e.payload.paths[0]
          if (p) handleStartup(/\.[a-z0-9]{2,5}$/i.test(p) ? { file: p, folder: null } : { file: null, folder: p })
        }
      }),
    ]
    const w = getCurrentWindow()
    w.isMaximized().then(setMaximized)
    const un = w.onResized(() => w.isMaximized().then(setMaximized))
    return () => {
      subs.forEach((s) => s.then((f) => f()))
      un.then((f) => f())
    }
  }, [bumpLibrary])

  // Auto update check a little after start.
  useEffect(() => {
    if (!settings?.autoUpdate) return
    const t = setTimeout(() => checkForUpdate(false), 8000)
    return () => clearTimeout(t)
  }, [settings?.autoUpdate])

  // Accent colour.
  useEffect(() => {
    const [a, b] = ACCENTS[settings?.accent ?? 'aurora'] ?? ACCENTS.aurora
    document.documentElement.style.setProperty('--a1', a)
    document.documentElement.style.setProperty('--a2', b)
  }, [settings?.accent])

  // Global shortcuts (gallery).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useStore.getState().viewer) return
      if ((e.ctrlKey && (e.key === 'k' || e.key === 'f')) || (e.key === '/' && !(e.target as HTMLElement)?.closest?.('input'))) {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape') {
        if (useStore.getState().selection.size) useStore.getState().setSelection(new Set())
        else if ((e.target as HTMLElement)?.closest?.('input')) (e.target as HTMLElement).blur()
      } else if (e.key === 'Backspace' && e.altKey) useStore.getState().back()
      else if (e.ctrlKey && e.key === ',') go({ kind: 'settings' })
    }
    const onMouse = (e: MouseEvent) => e.button === 3 && useStore.getState().back()
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [go])

  if (!settings) return <div className="boot" />

  const standalone = viewer?.origin === 'file'
  const collapsed = settings.sidebarCollapsed
  const searching = search.trim().length > 0

  return (
    <div className={`app${collapsed ? ' collapsed' : ''}${viewer ? ' viewing' : ''}`}>
      {!standalone && (
        <>
          <header className="titlebar" data-tauri-drag-region>
            <div className="brand" data-tauri-drag-region>
              <Logo size={22} />
              <span data-tauri-drag-region>MeowViewer</span>
            </div>
            <div className="search">
              <Search size={16} />
              <input
                ref={searchRef}
                value={search}
                placeholder="Search text in photos, tags, places, folders, cameras…"
                onChange={(e) => {
                  setSearch(e.target.value)
                  if (['albums', 'trash', 'settings', 'private', 'tools', 'places'].includes(view.kind))
                    useStore.setState({ view: { kind: 'photos' } })
                }}
                spellCheck={false}
              />
              {searching ? (
                <button className="icon-btn sm" onClick={() => setSearch('')}>
                  <X size={14} />
                </button>
              ) : (
                <kbd>Ctrl K</kbd>
              )}
            </div>
            <div className="titlebar-right" data-tauri-drag-region>
              {progress?.scanning && (
                <div className="indexing" title="Indexing your library">
                  <span className="pulse" />
                  {progress.found.toLocaleString()} items
                </div>
              )}
              <WindowButtons maximized={maximized} />
            </div>
          </header>

          <nav className="sidebar">
            {NAV.map((n) => (
              <button
                key={n.label}
                className={`nav${view.kind === n.view.kind ? ' on' : ''}`}
                onClick={() => go(n.view)}
                title={n.label}
              >
                {n.icon}
                <span>{n.label}</span>
              </button>
            ))}
            <span className="spacer" />
            <button className={`nav${view.kind === 'settings' ? ' on' : ''}`} onClick={() => go({ kind: 'settings' })} title="Settings">
              <Cog size={19} />
              <span>Settings</span>
            </button>
            <button className="nav" onClick={() => patchSettings({ sidebarCollapsed: !collapsed })} title="Collapse sidebar">
              {collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
              <span>Collapse</span>
            </button>
          </nav>

          <main className="content">
            {view.kind === 'albums' ? (
              <AlbumsView />
            ) : view.kind === 'places' && !searching ? (
              <Suspense fallback={<div className="spinner" />}>
                <MapView />
              </Suspense>
            ) : view.kind === 'private' ? (
              <PrivateView />
            ) : view.kind === 'tools' ? (
              <ToolsView />
            ) : view.kind === 'trash' ? (
              <TrashView />
            ) : view.kind === 'settings' ? (
              <SettingsView />
            ) : (
              <LibraryView key={JSON.stringify(view)} />
            )}
          </main>
        </>
      )}

      {viewer && <Viewer />}
      {editing && <Editor path={editing} />}
      {comparing && <Compare paths={comparing} />}
      {dropping && (
        <div className="drop-overlay">
          <div className="drop-card glass">Drop to open</div>
        </div>
      )}
      <MenuHost />
      <DialogHost />
      <UnlockHost />
      <ExportDialog />
      {!settings.onboarded && !standalone && <Onboarding />}
      <Toasts />
    </div>
  )
}
