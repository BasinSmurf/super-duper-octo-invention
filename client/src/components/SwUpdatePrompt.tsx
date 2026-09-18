import { useState } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
import { applyServiceWorkerUpdate } from '@/lib/sw-register'

interface SwUpdatePromptProps {
  show: boolean
}

export function SwUpdatePrompt({ show }: SwUpdatePromptProps) {
  const [updating, setUpdating] = useState(false)

  if (!show) return null

  async function handleClick() {
    if (updating) return
    setUpdating(true)
    await applyServiceWorkerUpdate()
    // No need to reset — the page reloads inside applyServiceWorkerUpdate.
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-blue-800 text-white safe-area-pb">
      <button
        onClick={handleClick}
        disabled={updating}
        className="flex items-center justify-center gap-3 w-full px-4 py-4 min-h-[56px] text-sm font-medium hover:bg-blue-700 transition-colors active:bg-blue-900 disabled:opacity-80"
      >
        {updating ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            Updating…
          </>
        ) : (
          <>
            <RefreshCw className="w-5 h-5" />
            Update available — tap to refresh
          </>
        )}
      </button>
    </div>
  )
}
