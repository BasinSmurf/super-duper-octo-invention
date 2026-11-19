import { createContext, useContext } from 'react'

export interface Branding { companyName: string; logoUrl: string; hasCustomLogo: boolean }
export const DEFAULT_BRANDING: Branding = { companyName: 'Basin Safety', logoUrl: '/servicepro-logo.png', hasCustomLogo: false }
export const BrandingContext = createContext({ branding: DEFAULT_BRANDING, refreshBranding: async () => {} })
export function useBranding() { return useContext(BrandingContext) }

export async function fetchBranding(signal?: AbortSignal): Promise<Branding> {
  const response = await fetch('/api/branding', { cache: 'no-store', signal })
  if (!response.ok) throw new Error('Could not load company branding')
  return response.json() as Promise<Branding>
}
