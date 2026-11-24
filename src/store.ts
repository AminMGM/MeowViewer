import { create } from 'zustand'
import { api, type Item, type Settings } from './api'

export type View =
  | { kind: 'photos' }
  | { kind: 'albums' }
  | { kind: 'videos' }
  | { kind: 'favorites' }
  | { kind: 'recent' }
  | { kind: 'places' }
  | { kind: 'trash' }
  | { kind: 'settings' }
  | { kind: 'folder'; path: string }
  | { kind: 'source'; source: string }
  | { kind: 'type'; type: number }
  | { kind: 'private' }
  | { kind: 'tools' }
  | { kind: 'album'; id: number; name: string; smart?: string | null }
  | { kind: 'tag'; tag: string }
  | { kind: 'onthisday' }

export interface ViewerState {
  items: Item[]
  index: number
  /** 'file' = opened from Explorer (standalone, no gallery behind it yet). */
  origin: 'gallery' | 'file'
  slideshow?: boolean
  /** Items from the private album: paths are vault ids. */
  vault?: boolean
}

export interface Toast {
  id: number
  text: string
  action?: { label: string; run: () => void }
  sticky?: boolean
}

interface Store {
  settings: Settings | null
  view: View
  history: View[]
  search: string
  viewer: ViewerState | null
  selection: Set<string>
  libVersion: number
  toasts: Toast[]
  ready: boolean
  editing: string | null
  compare: string[] | null
  setEditing: (p: string | null) => void
  setCompare: (p: string[] | null) => void

  loadSettings: () => Promise<void>
  patchSettings: (p: Partial<Settings>) => void
  go: (v: View) => void
  back: () => void
  setSearch: (s: string) => void
  openViewer: (v: ViewerState) => void
  closeViewer: () => void
  setViewerIndex: (i: number) => void
  updateViewerItems: (fn: (items: Item[]) => Item[]) => void
  toggleSelect: (p: string, on?: boolean) => void
  setSelection: (s: Set<string>) => void
  bumpLibrary: () => void
  toast: (t: Omit<Toast, 'id'>) => number
  dismiss: (id: number) => void
  setReady: () => void
}

let toastId = 0
let saveTimer: number | undefined

export const useStore = create<Store>((set, get) => ({
  settings: null,
  view: { kind: 'photos' },
  history: [],
  search: '',
  viewer: null,
  selection: new Set(),
  libVersion: 0,
  toasts: [],
  ready: false,
  editing: null,
  compare: null,
  setEditing: (p) => set({ editing: p }),
  setCompare: (p) => set({ compare: p }),

  loadSettings: async () => set({ settings: await api.settings() }),
  patchSettings: (p) => {
    const cur = get().settings
    if (!cur) return
    const next = { ...cur, ...p }
    set({ settings: next })
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => api.saveSettings(next), 250)
  },
  go: (v) => {
    const { view, history } = get()
    if (JSON.stringify(v) === JSON.stringify(view)) return
    set({ view: v, history: [...history.slice(-30), view], selection: new Set(), search: '' })
  },
  back: () => {
    const h = get().history
    if (!h.length) return
    set({ view: h[h.length - 1], history: h.slice(0, -1), selection: new Set() })
  },
  setSearch: (s) => set({ search: s }),
  openViewer: (v) => set({ viewer: v }),
  closeViewer: () => set({ viewer: null }),
  setViewerIndex: (i) => {
    const v = get().viewer
    if (v) set({ viewer: { ...v, index: i } })
  },
  updateViewerItems: (fn) => {
    const v = get().viewer
    if (!v) return
    const items = fn(v.items)
    if (!items.length) return set({ viewer: null })
    set({ viewer: { ...v, items, index: Math.min(v.index, items.length - 1) } })
  },
  toggleSelect: (p, on) => {
    const s = new Set(get().selection)
    const want = on ?? !s.has(p)
    if (want) s.add(p)
    else s.delete(p)
    set({ selection: s })
  },
  setSelection: (s) => set({ selection: s }),
  bumpLibrary: () => set({ libVersion: get().libVersion + 1 }),
  toast: (t) => {
    const id = ++toastId
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] })
    if (!t.sticky) setTimeout(() => get().dismiss(id), t.action ? 6000 : 3200)
    return id
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setReady: () => set({ ready: true }),
}))

export const toast = (text: string, action?: Toast['action']) => useStore.getState().toast({ text, action })
