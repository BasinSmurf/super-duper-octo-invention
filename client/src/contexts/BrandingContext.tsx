import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { BrandingContext, DEFAULT_BRANDING, fetchBranding } from '@/lib/branding'

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState(DEFAULT_BRANDING)
  const refreshBranding = useCallback(async () => {
    setBranding(await fetchBranding())
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    fetchBranding(controller.signal)
      .then(value => { if (!controller.signal.aborted) setBranding(value) })
      .catch(() => {})
    return () => controller.abort()
  }, [])
  return <BrandingContext.Provider value={{ branding, refreshBranding }}>{children}</BrandingContext.Provider>
}
