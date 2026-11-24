import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { ChevronRight, X } from 'lucide-react'
import { useStore } from '../store'

// ------------------------------------------------------------- menus

export interface MenuItem {
  label?: string
  icon?: ReactNode
  hint?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  run?: () => void
  items?: MenuItem[]
}

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null
  open: (x: number, y: number, items: MenuItem[]) => void
  close: () => void
}

export const useMenu = create<MenuState>((set) => ({
  menu: null,
  open: (x, y, items) => set({ menu: { x, y, items } }),
  close: () => set({ menu: null }),
}))

export const openMenu = (e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) => {
  e.preventDefault?.()
  useMenu.getState().open(e.clientX, e.clientY, items)
}

/** Opens a menu anchored under a button. */
export const openMenuAt = (el: HTMLElement, items: MenuItem[], align: 'left' | 'right' = 'left') => {
  const r = el.getBoundingClientRect()
  useMenu.getState().open(align === 'left' ? r.left : r.right - 230, r.bottom + 6, items)
}

function MenuList({ items, x, y, onDone }: { items: MenuItem[]; x: number; y: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    })
  }, [x, y])
  return (
    <>
      <div className="menu glass" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, i) =>
          it.separator ? (
            <div key={i} className="menu-sep" />
          ) : (
            <button
              key={i}
              className={`menu-item${it.danger ? ' danger' : ''}${sub?.i === i ? ' active' : ''}`}
              disabled={it.disabled}
              onMouseEnter={(e) => {
                if (it.items) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setSub({ i, x: r.right + 4, y: r.top - 6 })
                } else setSub(null)
              }}
              onClick={() => {
                if (it.items) return
                onDone()
                it.run?.()
              }}
            >
              <span className="menu-icon">{it.icon}</span>
              <span className="menu-label">{it.label}</span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
              {it.items && <ChevronRight size={14} className="menu-hint" />}
            </button>
          ),
        )}
      </div>
      {sub && items[sub.i]?.items && (
        <MenuList items={items[sub.i].items!} x={sub.x} y={sub.y} onDone={onDone} />
      )}
    </>
  )
}

export function MenuHost() {
  const { menu, close } = useMenu()
  useEffect(() => {
    if (!menu) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', k, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', k, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu, close])
  if (!menu) return null
  return (
    <div
      className="menu-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onContextMenu={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <MenuList key={`${menu.x},${menu.y}`} items={menu.items} x={menu.x} y={menu.y} onDone={close} />
    </div>
  )
}

// ------------------------------------------------------------- dialogs

interface DialogState {
  dialog: {
    title: string
    message?: string
    input?: string
    confirm: string
    danger?: boolean
    resolve: (v: string | null) => void
  } | null
  show: (d: NonNullable<DialogState['dialog']>) => void
  hide: () => void
}

const useDialog = create<DialogState>((set) => ({
  dialog: null,
  show: (dialog) => set({ dialog }),
  hide: () => set({ dialog: null }),
}))

export const prompt = (title: string, value: string, confirm = 'Save') =>
  new Promise<string | null>((resolve) => useDialog.getState().show({ title, input: value, confirm, resolve }))

export const confirmDialog = (title: string, message: string, confirm = 'OK', danger = false) =>
  new Promise<boolean>((resolve) =>
    useDialog.getState().show({ title, message, confirm, danger, resolve: (v) => resolve(v !== null) }),
  )

export function DialogHost() {
  const { dialog, hide } = useDialog()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!dialog) return
    setValue(dialog.input ?? '')
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const dot = el.value.lastIndexOf('.')
      el.setSelectionRange(0, dot > 0 ? dot : el.value.length)
    })
  }, [dialog])
  if (!dialog) return null
  const done = (v: string | null) => {
    hide()
    dialog.resolve(v)
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <form
        className="modal glass"
        onSubmit={(e) => {
          e.preventDefault()
          done(dialog.input !== undefined ? value : '')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            done(null)
          }
        }}
      >
        <h3>{dialog.title}</h3>
        {dialog.message && <p>{dialog.message}</p>}
        {dialog.input !== undefined && (
          <input ref={inputRef} className="field" value={value} onChange={(e) => setValue(e.target.value)} />
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => done(null)}>
            Cancel
          </button>
          <button type="submit" className={`btn ${dialog.danger ? 'danger' : 'primary'}`} autoFocus={dialog.input === undefined}>
            {dialog.confirm}
          </button>
        </div>
      </form>
    </div>
  )
}

// -------------------------------------------------------------- toasts

export function Toasts() {
  const { toasts, dismiss } = useStore()
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast glass">
          <span>{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                dismiss(t.id)
                t.action!.run()
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn sm" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------ helpers

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={`toggle${on ? ' on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)} />
}
