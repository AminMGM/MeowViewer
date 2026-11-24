import { useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { Map as MlMap, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// Bundle MapLibre's tile worker (and its shared chunk) explicitly so release builds ship it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Images, MapPinOff, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { api, errText, thumbUrl, type Item, type Located } from '../api'
import { toast, useStore } from '../store'
import { MediaGrid } from '../components/MediaGrid'

/** Palettes modelled on Snazzy Maps "Masik WWW" (light) and "Shades of Grey" (dark). */
const PALETTE = {
  light: {
    bg: '#ececec', land: '#e4e4e4', water: '#bfc3c6', building: '#dddddd', major: '#ffffff', minor: '#fbfbfb',
    casing: '#d6d6d6', boundary: '#acacac', label: '#484848', halo: '#efefef', rail: '#d0d0d0',
  },
  dark: {
    bg: '#333333', land: '#353535', water: '#2b2b2b', building: '#303030', major: '#2b2b2b', minor: '#2e2e2e',
    casing: '#4a4a4a', boundary: '#4d4d4d', label: '#7a7a7a', halo: '#292929', rail: '#3a3a3a',
  },
}

maplibregl.setWorkerUrl(workerUrl)
// One tile worker is plenty for a photo map and keeps memory down.
try {
  ;(maplibregl as unknown as { setWorkerCount?: (n: number) => void }).setWorkerCount?.(1)
} catch {
  /* older API */
}

let baseStyle: Promise<StyleSpecification> | null = null
const loadBase = () =>
  (baseStyle ??= fetch('https://tiles.openfreemap.org/styles/positron').then((r) => r.json() as Promise<StyleSpecification>))

function themed(base: StyleSpecification, mode: 'light' | 'dark'): StyleSpecification {
  const c = PALETTE[mode]
  const style: StyleSpecification = JSON.parse(JSON.stringify(base))
  style.layers = style.layers
    .filter((l) => !(l.type === 'raster'))
    .map((l) => {
      const id = l.id.toLowerCase()
      const paint = { ...((l as { paint?: Record<string, unknown> }).paint ?? {}) }
      const layout = { ...((l as { layout?: Record<string, unknown> }).layout ?? {}) }
      if (l.type === 'background') paint['background-color'] = c.bg
      else if (l.type === 'fill') {
        paint['fill-color'] = id.includes('water')
          ? c.water
          : id.includes('building')
            ? c.building
            : id.includes('park') || id.includes('landcover') || id.includes('landuse') || id.includes('wood')
              ? c.land
              : c.bg
        delete paint['fill-pattern']
        if (id.includes('building')) paint['fill-outline-color'] = c.building
      } else if (l.type === 'line') {
        const col = id.includes('water')
          ? c.water
          : id.includes('boundary') || id.includes('admin')
            ? c.boundary
            : id.includes('rail') || id.includes('transit')
              ? c.rail
              : id.includes('casing')
                ? c.casing
                : /motorway|trunk|major|primary|highway/.test(id)
                  ? c.major
                  : c.minor
        paint['line-color'] = col
      } else if (l.type === 'symbol') {
        paint['text-color'] = id.includes('water') ? (mode === 'dark' ? '#555' : '#8d9295') : c.label
        paint['text-halo-color'] = c.halo
        paint['icon-opacity'] = 0
        if (id.includes('poi')) layout.visibility = 'none'
      }
      return { ...l, paint, layout } as typeof l
    })
  return style
}

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

interface Cluster {
  lng: number
  lat: number
  items: Located[]
}

export default function MapView() {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MlMap | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const libVersion = useStore((s) => s.libVersion)
  const [points, setPoints] = useState<Located[] | null>(null)
  const [inView, setInView] = useState<Located[]>([])
  const [panel, setPanel] = useState(true)
  const [theme, setTheme] = useState(currentTheme())

  useEffect(() => {
    api.located().then(setPoints, (e) => toast(errText(e)))
  }, [libVersion])

  // Follow the app theme.
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(currentTheme()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])

  // Create the map once.
  useEffect(() => {
    let disposed = false
    loadBase()
      .then((base) => {
        if (disposed || !el.current) return
        const m = new maplibregl.Map({
          container: el.current,
          style: themed(base, currentTheme()),
          center: [20, 25],
          zoom: 1.6,
          attributionControl: { compact: true },
          fadeDuration: 0,
          maxTileCacheSize: 120,
        })
        m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
        map.current = m
        m.on('load', () => setTheme(currentTheme()))
      })
      .catch(() => toast("Couldn't load the map — check your internet connection"))
    return () => {
      disposed = true
      markers.current.forEach((mk) => mk.remove())
      map.current?.remove()
      map.current = null
    }
  }, [])

  useEffect(() => {
    const m = map.current
    if (!m) return
    loadBase().then((base) => m.setStyle(themed(base, theme)))
  }, [theme])

  // Fit to photos the first time they arrive.
  const fitted = useRef(false)
  useEffect(() => {
    const m = map.current
    if (!m || !points?.length || fitted.current) return
    const b = new maplibregl.LngLatBounds()
    for (const p of points) b.extend([p[2], p[1]])
    m.fitBounds(b, { padding: 80, maxZoom: 12, duration: 0 })
    fitted.current = true
  }, [points, theme])

  // Screen-space clustering, recomputed when the view settles.
  useEffect(() => {
    const m = map.current
    if (!m || !points) return
    const render = () => {
      markers.current.forEach((mk) => mk.remove())
      markers.current = []
      const bounds = m.getBounds()
      const visible = points.filter((p) => bounds.contains([p[2], p[1]]))
      setInView(visible)
      const cell = 76
      const grid = new Map<string, Cluster>()
      for (const p of visible) {
        const pt = m.project([p[2], p[1]])
        const key = `${Math.floor(pt.x / cell)}:${Math.floor(pt.y / cell)}`
        const c = grid.get(key)
        if (c) c.items.push(p)
        else grid.set(key, { lng: p[2], lat: p[1], items: [p] })
      }
      for (const c of grid.values()) {
        const node = document.createElement('button')
        node.className = 'map-pin'
        node.innerHTML = `<img src="${thumbUrl(c.items[0][0], 320)}" alt="" />${
          c.items.length > 1 ? `<span>${c.items.length > 999 ? '999+' : c.items.length}</span>` : ''
        }`
        node.onclick = () => {
          if (c.items.length > 1 && m.getZoom() < 15) {
            const b = new maplibregl.LngLatBounds()
            for (const p of c.items) b.extend([p[2], p[1]])
            m.fitBounds(b, { padding: 120, maxZoom: 16 })
          } else {
            const items: Item[] = c.items.map((p) => [0, p[0], p[3], p[4], false, 0, 0, 0])
            useStore.getState().openViewer({ items, index: 0, origin: 'gallery' })
          }
        }
        markers.current.push(new maplibregl.Marker({ element: node }).setLngLat([c.lng, c.lat]).addTo(m))
      }
    }
    if (m.loaded()) render()
    m.on('moveend', render)
    m.on('styledata', render)
    return () => {
      m.off('moveend', render)
      m.off('styledata', render)
    }
  }, [points])

  const gridItems = useMemo<Item[]>(() => inView.map((p) => [0, p[0], p[3], p[4], false, 0, 0, 0]), [inView])

  return (
    <div className={`map-view${panel ? ' with-panel' : ''}`}>
      <div className="map-canvas" ref={el} />
      <div className="map-head glass">
        <strong>Places</strong>
        <span className="muted">{points ? `${points.length.toLocaleString()} photos with location` : 'Loading…'}</span>
        <button className="icon-btn sm" onClick={() => setPanel((p) => !p)} title="Photos in view">
          {panel ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
      </div>
      {points && points.length === 0 && (
        <div className="map-empty glass">
          <MapPinOff size={22} />
          <span>No photos with GPS location yet. Phone photos usually have it; add a location from the Info panel.</span>
        </div>
      )}
      {panel && (
        <aside className="map-panel glass">
          <header>
            <Images size={16} />
            <strong>{inView.length.toLocaleString()} in view</strong>
          </header>
          <div className="map-panel-grid">
            <MediaGrid items={gridItems} group="none" />
          </div>
        </aside>
      )}
    </div>
  )
}
