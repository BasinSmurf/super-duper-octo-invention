import { useEffect, useState } from 'react'
import { WifiOff } from 'lucide-react'

interface OfflineReadyToastProps {
  show: boolean
  onDismiss: () => void
}

export function OfflineReadyToast({ show, onDismiss }: OfflineReadyToastProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!show) return
    setVisible(true)
    const timer = setTimeout(() => {
      setVisible(false)
      onDismiss()
    }, 3000)
    return () => clearTimeout(timer)
  }, [show, onDismiss])

  if (!visible) return null

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 flex justify-center pointer-events-none">
      <div className="bg-slate-900 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 text-sm font-medium pointer-events-auto">
        <WifiOff className="w-4 h-4 text-green-400" />
        App ready for offline use
      </div>
    </div>
  )
}
