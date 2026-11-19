import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface Result<T> { key: string; data: T | null; error: string | null }

/** A result belongs to its URL and account; old requests cannot publish into a new selection. */
export function useApiResource<T>(path: string | null, accountScope: string) {
  const [result, setResult] = useState<Result<T> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([path, accountScope, attempt])
  const reload = useCallback(() => setAttempt(value => value + 1), [])

  useEffect(() => {
    if (path === null) return
    const controller = new AbortController()
    api.get<T>(path, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult({ key, data, error: null }) })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ key, data: null, error: error instanceof Error ? error.message : 'Could not load data' })
      })
    return () => controller.abort()
  }, [path, key])

  const current = path !== null && result?.key === key ? result : null
  return { data: current?.data ?? null, error: current?.error ?? null, loading: path !== null && current === null, reload }
}
