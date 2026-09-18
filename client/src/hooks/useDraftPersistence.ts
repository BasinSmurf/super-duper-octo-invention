import { useEffect, useRef, useCallback, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/lib/db'
import type { OfflineDraft, WizardDraftData } from '@/lib/db-types'

const DEBOUNCE_MS = 500

/**
 * Hook for auto-saving ticket wizard drafts to IndexedDB.
 *
 * @param draftId - Unique draft ID (UUID). Carried in URL as ?draft=<id>.
 * @returns { draft, saveDraft, clearDraft, isLoaded }
 */
export function useDraftPersistence(draftId: string) {
  const [isLoaded, setIsLoaded] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reactively read the draft from Dexie
  const draft = useLiveQuery(
    () => db.drafts.get(draftId),
    [draftId],
  )

  // Mark loaded once Dexie resolves (even if draft is undefined = no saved draft)
  useEffect(() => {
    if (draft !== undefined || isLoaded) return
    // useLiveQuery returns undefined while loading, then the actual value (or undefined if not found)
    // We need to detect when the query has actually resolved
    const checkLoaded = async () => {
      const existing = await db.drafts.get(draftId)
      // existing will be undefined if no draft, or the draft object
      setIsLoaded(true)
      return existing
    }
    checkLoaded()
  }, [draftId, draft, isLoaded])

  const saveDraft = useCallback((wizardData: WizardDraftData, step: number) => {
    if (timerRef.current) clearTimeout(timerRef.current)

    timerRef.current = setTimeout(async () => {
      const entry: OfflineDraft = {
        id: draftId,
        ticketId: null,
        step,
        wizardData,
        updatedAt: new Date().toISOString(),
      }
      await db.drafts.put(entry)
    }, DEBOUNCE_MS)
  }, [draftId])

  const clearDraft = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    await db.drafts.delete(draftId)
  }, [draftId])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return {
    draft: (draft ?? null) as OfflineDraft | null,
    saveDraft,
    clearDraft,
    isLoaded,
  }
}
