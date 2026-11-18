const API_BASE = '/api'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('sundog_token')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const portalPreviewCompanyId = sessionStorage.getItem('sundog_portal_preview_company_id')
  if (portalPreviewCompanyId && path.startsWith('/portal')) {
    headers['X-Portal-Preview-Company-Id'] = portalPreviewCompanyId
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  })

  // An obsolete request must not log out a newer account after its response arrives.
  if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError')

  if (res.status === 401) {
    if (localStorage.getItem('sundog_token') !== token) {
      throw new ApiError(401, 'Session changed; please retry')
    }
    localStorage.removeItem('sundog_token')
    localStorage.removeItem('sundog_user')
    window.location.href = '/login'
    throw new ApiError(401, 'Session expired')
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new ApiError(res.status, body.error || `Request failed (${res.status})`)
  }

  if (res.status === 204) return undefined as T

  return res.json()
}

export const api = {
  get: <T>(path: string, options?: Pick<RequestInit, 'signal'>) => request<T>(path, options),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined }),
  /** Upload a file via FormData (skips Content-Type so browser sets multipart boundary) */
  upload: <T>(path: string, formData: FormData) => {
    const token = localStorage.getItem('sundog_token')
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    return fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: formData })
      .then(async (res) => {
        if (res.status === 401) {
          localStorage.removeItem('sundog_token')
          localStorage.removeItem('sundog_user')
          window.location.href = '/login'
          throw new ApiError(401, 'Session expired')
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Upload failed' }))
          throw new ApiError(res.status, body.error || 'Upload failed')
        }
        return res.json() as Promise<T>
      })
  },
}
