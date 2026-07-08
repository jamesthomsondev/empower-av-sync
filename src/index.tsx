import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import './styles.css'

// SW registration is production-only; use `yarn build && yarn preview` for offline testing.
if (import.meta.env.PROD) {
  void import('./service-worker-registration').then((m) => m.registerServiceWorker())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
