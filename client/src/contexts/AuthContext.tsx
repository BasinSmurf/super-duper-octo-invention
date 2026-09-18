import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { api, ApiError } from '@/lib/api'

interface User {
  id: string
  email: string
  name: string
  role: string
  companyId?: string | null
  homeSiteId?: string | null
  hasPin?: boolean
}

interface AuthConfig {
  googleClientId: string | null
  googleEnabled: boolean
  pinEnabled: boolean
  passwordEnabled: boolean
}

interface AuthContextType {
  user: User | null
  config: AuthConfig | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  loginWithPin: (email: string, pin: string) => Promise<void>
  loginWithGoogle: (idToken: string) => Promise<void>
  logout: () => void
  /** Flip the cached user to hasPin=true after they set a PIN (dismisses the nag). */
  markPinSet: () => void
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const stored = localStorage.getItem('sundog_user')
    return stored ? JSON.parse(stored) : null
  })
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Fetch auth config (public endpoint)
    api.get<AuthConfig>('/auth/config').then(setConfig).catch(() => {})

    // Verify existing token
    const token = localStorage.getItem('sundog_token')
    if (token) {
      api.get<User>('/auth/me')
        .then((u) => {
          setUser(u)
          localStorage.setItem('sundog_user', JSON.stringify(u))
        })
        .catch((err) => {
          // Only drop the session on an actual auth rejection. A network error
          // (offline in the field) must NOT log the tech out — keep the cached
          // user so the PWA stays usable and offline-saved work (which is keyed
          // to user.id) stays visible. A 401 already redirects in api.ts.
          if (err instanceof ApiError && err.status === 401) {
            localStorage.removeItem('sundog_token')
            localStorage.removeItem('sundog_user')
            setUser(null)
          }
        })
        .finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [])

  function handleLoginResponse(data: { token: string; user: User }) {
    localStorage.setItem('sundog_token', data.token)
    localStorage.setItem('sundog_user', JSON.stringify(data.user))
    setUser(data.user)
  }

  async function login(email: string, password: string) {
    const data = await api.post<{ token: string; user: User }>('/auth/login', { email, password })
    handleLoginResponse(data)
  }

  async function loginWithPin(email: string, pin: string) {
    const data = await api.post<{ token: string; user: User }>('/auth/pin', { email, pin })
    handleLoginResponse(data)
  }

  async function loginWithGoogle(idToken: string) {
    const data = await api.post<{ token: string; user: User }>('/auth/google', { idToken })
    handleLoginResponse(data)
  }

  function logout() {
    localStorage.removeItem('sundog_token')
    localStorage.removeItem('sundog_user')
    setUser(null)
  }

  function markPinSet() {
    setUser((prev) => {
      if (!prev) return prev
      const next = { ...prev, hasPin: true }
      localStorage.setItem('sundog_user', JSON.stringify(next))
      return next
    })
  }

  return (
    <AuthContext.Provider value={{ user, config, loading, login, loginWithPin, loginWithGoogle, logout, markPinSet }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
