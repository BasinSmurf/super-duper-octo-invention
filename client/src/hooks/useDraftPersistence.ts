import { useEffect, useRef, useCallback } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/lib/db'
import type { OfflineDraft, WizardDraftData } from '@/lib/db-types'

const DEBOUNCE_MS = 500
const AUTOSAVE_INTERVAL_MS = 30_000

/**
 * Hook for auto-saving ticket wizard drafts to IndexedDB.
 *
 * Three things write the draft:
 *  - a short debounce after every change (the normal path),
 *  - a 30s interval, so a snapshot can never sit unwritten for longer,
 *  - the page being hidden or the wizard unmounting. Opening the camera for a
 *    site-sign photo backgrounds the PWA, and the OS is free to kill it there;
 *    a debounce timer that has not fired yet dies with the page, so the
 *    snapshot is written on the way out instead.
 *
 * @param draftId - Unique draft ID (UUID). Carried in URL as ?draft=<id>.
 * @returns { draft, saveDraft, clearDraft, isLoaded }
 */
export function useDraftPersistence(draftId: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest snapshot that has not reached IndexedDB yet.
  const pendingRef = useRef<OfflineDraft | null>(null)
  // Set by clearDraft (submit / save). Until the debounce next fires, the
  // out-of-band flushes below stand down so a stray re-render between "ticket
  // saved" and "navigated away" cannot resurrect the draft just deleted.
  const clearedRef = useRef(false)

  // Publish readiness and data from the SAME read. A separate readiness read
  // can finish before the live query and make the wizard restore an empty
  // draft, redirect to the type picker, and potentially auto-save over it.
  // The wrapper distinguishes "not found" from "still loading"; the id also
  // prevents a previous query's result being used after navigation.
  const result = useLiveQuery(
    async () => ({ id: draftId, draft: await db.drafts.get(draftId) ?? null }),
    [draftId],
  )
  const isLoaded = result !== undefined && result.id === draftId

  const writePending = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    const entry = pendingRef.current
    if (!entry) return
    pendingRef.current = null
    void db.drafts.put(entry).catch(() => {
      // Keep the snapshot for the next attempt unless a newer one replaced it.
      if (!pendingRef.current) pendingRef.current = entry
    })
  }, [])

  const flushNow = useCallback(() => {
    if (clearedRef.current) return
    writePending()
  }, [writePending])

  const saveDraft = useCallback((wizardData: WizardDraftData, step: number) => {
    pendingRef.current = {
      id: draftId,
      ticketId: null,
      step,
      wizardData,
      updatedAt: new Date().toISOString(),
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      clearedRef.current = false
      writePending()
    }, DEBOUNCE_MS)
  }, [draftId, writePending])

  const clearDraft = useCallback(async () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    pendingRef.current = null
    clearedRef.current = true
    await db.drafts.delete(draftId)
  }, [draftId])

  useEffect(() => { clearedRef.current = false }, [draftId])

  useEffect(() => {
    const interval = setInterval(flushNow, AUTOSAVE_INTERVAL_MS)
    const onHidden = () => { if (document.visibilityState === 'hidden') flushNow() }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', flushNow)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', flushNow)
      // Leaving the wizard: write whatever the debounce was still holding.
      flushNow()
    }
  }, [flushNow])

  return {
    draft: isLoaded ? result.draft : null,
    saveDraft,
    clearDraft,
    isLoaded,
  }
}
