import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * App-wide error boundary. Without this, any render-time exception unmounts the
 * whole React tree and the page goes blank (white screen). Here we catch it and
 * offer a reload — which also clears the known "blank tab after a Vite dep
 * re-optimize" state (see MEMORY: hard refresh fixes it).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown) {
    // Surfaced into the console ring buffer used by bug reports.
    console.error('Unhandled render error:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
          <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-6 text-center shadow-sm">
            <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
            <p className="text-sm text-slate-500 mt-2">
              The page hit an unexpected error and stopped rendering. Reloading usually fixes it.
            </p>
            <pre className="text-xs text-left text-red-600 bg-red-50 rounded p-2 mt-3 overflow-auto max-h-32">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
