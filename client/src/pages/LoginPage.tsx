import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { cn } from '@/lib/cn'

type LoginMode = 'google' | 'password' | 'pin'

export function LoginPage() {
  const { config, login, loginWithPin } = useAuth()
  const [mode, setMode] = useState<LoginMode>(config?.googleEnabled ? 'google' : 'password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const googleBtnRef = useRef<HTMLDivElement>(null)

  // The Google redirect callback bounces auth failures back as ?authError=…
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const authError = params.get('authError')
    if (authError) {
      setError(authError)
      params.delete('authError')
      const qs = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
  }, [])

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  async function handlePinLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await loginWithPin(email, pin)
    } catch (err: any) {
      setError(err.message || 'Invalid PIN')
    } finally {
      setLoading(false)
    }
  }

  // Render the Google Sign-In button when the Google SSO tab is active
  useEffect(() => {
    if (mode !== 'google' || !config?.googleClientId || !googleBtnRef.current) return

    // @ts-ignore — Google Identity Services loaded via script tag
    const google = window.google
    if (!google?.accounts?.id) {
      // GIS script might still be loading — retry once
      const timer = setTimeout(() => {
        // @ts-ignore
        const g = window.google
        if (g?.accounts?.id && googleBtnRef.current) {
          initGoogleButton(g)
        } else {
          setError('Google Sign-In not loaded. Try PIN or password login.')
        }
      }, 1500)
      return () => clearTimeout(timer)
    }

    initGoogleButton(google)

    function initGoogleButton(g: any) {
      g.accounts.id.initialize({
        client_id: config!.googleClientId,
        // Redirect mode (not popup): Google navigates the whole tab and POSTs the
        // credential to our callback. Survives "block all popups" browser settings
        // and locked-down kiosk web views that kill popups. The server callback
        // seeds the session and bounces back to the app.
        ux_mode: 'redirect',
        login_uri: `${window.location.origin}/api/auth/google/callback`,
      })

      // Render the official Google button into our ref div
      g.accounts.id.renderButton(googleBtnRef.current!, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        width: googleBtnRef.current!.offsetWidth,
        text: 'signin_with',
      })
    }
  }, [mode, config?.googleClientId])

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-8">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <img
            src="/servicepro-logo.png"
            alt="Service Pro — Remote Ticketing and Management System"
            className="h-16 mx-auto mb-2"
          />
          <p className="text-slate-500 mt-1">Basin Safety Field Service</p>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}

        {/* Login mode tabs */}
        <div className="flex gap-1 mb-6 bg-slate-100 rounded-lg p-1">
          {config?.googleEnabled && (
            <button
              onClick={() => setMode('google')}
              className={cn(
                'flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors',
                mode === 'google' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
              )}
            >
              Google SSO
            </button>
          )}
          <button
            onClick={() => setMode('password')}
            className={cn(
              'flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors',
              mode === 'password' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            Password
          </button>
          <button
            onClick={() => setMode('pin')}
            className={cn(
              'flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors',
              mode === 'pin' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            PIN
          </button>
        </div>

        {/* Google SSO */}
        {mode === 'google' && (
          <div className="space-y-4">
            {/* Google renders its official button into this div */}
            <div ref={googleBtnRef} className="flex justify-center min-h-[44px]" />
            {loading && (
              <p className="text-sm text-center text-slate-500">Signing in...</p>
            )}
            <p className="text-xs text-center text-slate-400">
              Use your @basinsafetyus.com account
            </p>
          </div>
        )}

        {/* Password login */}
        {mode === 'password' && (
          <form onSubmit={handlePasswordLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                placeholder="you@basinsafetyus.com"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-blue-800 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        )}

        {/* PIN login */}
        {mode === 'pin' && (
          <form onSubmit={handlePinLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                placeholder="you@basinsafetyus.com"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">PIN</label>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                className="w-full px-3 py-4 border border-slate-300 rounded-lg text-center text-2xl tracking-[0.5em] focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                placeholder="----"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-blue-800 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign In with PIN'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
