import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { BrandingProvider } from './contexts/BrandingContext'
import { ErrorBoundary } from './components/ErrorBoundary'

// Tee console output into an in-memory ring buffer for bug reports
import { installConsoleBuffer } from './lib/consoleBuffer'
installConsoleBuffer()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrandingProvider><App /></BrandingProvider>
    </ErrorBoundary>
  </StrictMode>,
)
