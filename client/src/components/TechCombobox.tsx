import { useState, useRef, useEffect, useMemo } from 'react'
import { cn } from '@/lib/cn'
import { ChevronDown, Check, Search, X } from 'lucide-react'

interface Tech {
  id: string
  name: string
  role: string
}

interface Props {
  techs: Tech[]
  value: string
  onChange: (id: string) => void
  placeholder?: string
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Type-ahead tech selector — behaves like a US-state picker on a contact form.
 * The full roster is loaded once by the parent and filtered locally as you
 * type, so there are no per-keystroke network calls. Scrollable, keyboard-
 * navigable, with a clear button for the current selection.
 */
export function TechCombobox({ techs, value, onChange, placeholder = 'Select tech...', size = 'md', className }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = techs.find(t => t.id === value) || null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return techs
    return techs.filter(t => t.name.toLowerCase().includes(q))
  }, [techs, query])

  // Reset highlight whenever the filtered set changes or we (re)open.
  useEffect(() => { setHighlight(0) }, [query, open])

  // Focus the search box on open.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.children[highlight] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  function select(t: Tech) {
    onChange(t.id)
    setOpen(false)
    setQuery('')
  }

  function clear(e: React.MouseEvent) {
    e.stopPropagation()
    onChange('')
    setQuery('')
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(h => Math.min(h + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[highlight]) select(filtered[highlight])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      setQuery('')
    }
  }

  const pad = size === 'sm' ? 'px-2.5 py-1.5' : 'px-3 py-2'

  return (
    <div className={cn('relative', className)}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'w-full flex items-center justify-between gap-2 border border-slate-300 rounded-lg text-sm bg-white text-left focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none',
          pad,
        )}
      >
        <span className={cn('truncate', selected ? 'text-slate-900' : 'text-slate-400')}>
          {selected ? `${selected.name}${selected.role === 'field_super' ? ' (Sup)' : ''}` : placeholder}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {selected && (
            <X onClick={clear} className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600" />
          )}
          <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
        </span>
      </button>

      {open && (
        <>
          {/* Click-away catcher */}
          <div className="fixed inset-0 z-30" onClick={() => { setOpen(false); setQuery('') }} />
          <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-white rounded-lg shadow-xl border border-slate-200 overflow-hidden">
            <div className="p-2 border-b border-slate-100">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Type a name..."
                  className="w-full pl-8 pr-2 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div ref={listRef} className="max-h-56 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-3 text-sm text-slate-400 text-center">No techs match &ldquo;{query}&rdquo;</p>
              ) : (
                filtered.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => select(t)}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      'w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2',
                      i === highlight ? 'bg-blue-50' : 'hover:bg-slate-50',
                      t.id === value && 'font-medium',
                    )}
                  >
                    <span className="text-slate-900 truncate">
                      {t.name}
                      {t.role === 'field_super' && <span className="text-slate-400 font-normal"> (Sup)</span>}
                    </span>
                    {t.id === value && <Check className="w-4 h-4 text-blue-600 shrink-0" />}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
