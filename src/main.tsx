import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './styles-features.css'

// Keep the WebView feeling native: no browser context menu, no page zoom, no text-select drag.
window.addEventListener('contextmenu', (e) => {
  if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault()
})
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey && ['+', '-', '=', '0', 'r', 'u', 'g', 'j'].includes(e.key)) || e.key === 'F3' || e.key === 'F7') {
    if (!e.defaultPrevented) e.preventDefault()
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
