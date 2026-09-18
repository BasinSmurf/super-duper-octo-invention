// WizardShell.tsx — ADR-0013 division-first ticket wizard entry point.
//
// Strangler: this is the NEW top level. Picking a division → work-type delegates
// to the existing /tickets/new?type=… flow (which still does the real work) or
// redirects out. As each work-type is extracted into pages/wizard/steps/, its
// hand-off here gets repointed at the new module. Nothing in the monolith is
// touched until then.

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { DIVISIONS, type Division, type WorkEntry } from './divisions'

export function WizardShell() {
  const navigate = useNavigate()
  const [division, setDivision] = useState<Division | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<WorkEntry | null>(null)

  function chooseDivision(nextDivision: Division) {
    setDivision(nextDivision)
    setSelectedEntry(null)
  }

  function backToDivisions() {
    setDivision(null)
    setSelectedEntry(null)
  }

  function pick(entry: WorkEntry) {
    if (entry.comingSoon) return
    setSelectedEntry(entry)
  }

  function continueToTicket() {
    if (!division || !selectedEntry || selectedEntry.comingSoon) return
    if (selectedEntry.redirectTo) { navigate(selectedEntry.redirectTo); return }
    const params = new URLSearchParams()
    if (selectedEntry.workType) params.set('type', selectedEntry.workType)
    if (selectedEntry.serviceType) params.set('service', selectedEntry.serviceType)
    if (selectedEntry.subtype) params.set('subtype', selectedEntry.subtype)
    // ADR-0017: the division rides the path. The tech already declared it by
    // tapping a tile — stamp it so the wizard never asks again (Dickinson only).
    params.set('division', division.qbDivision)
    navigate(`/tickets/new?${params.toString()}`)
  }

  const canContinue = !!selectedEntry && !selectedEntry.comingSoon

  return (
    <div className="mx-auto max-w-3xl p-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">New Ticket</h1>
        <p className="text-sm text-slate-500">
          {division ? 'Pick what you did.' : 'Pick the division — the kind of work you’re logging.'}
        </p>
      </header>

      {!division ? (
        // ── Step 0: the four division buttons ──
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {DIVISIONS.map((d) => {
            const Icon = d.icon
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => chooseDivision(d)}
                className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-blue-500 hover:bg-blue-50"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-blue-700 text-white">
                  <Icon className="h-6 w-6" />
                </span>
                <span className="min-w-0">
                  <span className="block text-base font-semibold text-slate-900">{d.label}</span>
                  <span className="block text-sm text-slate-500">{d.subhead}</span>
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        // ── Step 1: the work-types within the chosen division ──
        <div>
          <button
            type="button"
            onClick={backToDivisions}
            className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft className="h-4 w-4" /> All divisions
          </button>
          <div className="mb-3 flex items-center gap-2">
            <span className="rounded-md bg-slate-900 px-2 py-1 text-xs font-semibold text-white">{division.label}</span>
            <span className="text-sm text-slate-500">{division.subhead}</span>
          </div>
          <div className="grid grid-cols-1 gap-2">
            {division.entries.map((entry) => {
              const Icon = entry.icon
              const selected = selectedEntry?.label === entry.label
              return (
                <div key={entry.label} className="rounded-lg">
                  <button
                    type="button"
                    disabled={entry.comingSoon}
                    onClick={() => pick(entry)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg border p-3 text-left transition',
                      entry.comingSoon
                        ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60'
                        : selected
                          ? 'border-blue-600 bg-blue-50'
                          : 'border-slate-200 bg-white hover:border-blue-500 hover:bg-blue-50',
                    )}
                  >
                    <Icon className={cn('h-5 w-5 shrink-0', entry.comingSoon ? 'text-slate-400' : 'text-blue-700')} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                        {entry.label}
                        {entry.comingSoon && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">SOON</span>}
                      </span>
                      <span className="block text-xs leading-4 text-slate-500">{entry.desc}</span>
                    </span>
                    {selected && <Check className="h-5 w-5 shrink-0 text-blue-700" />}
                  </button>
                </div>
              )
            })}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={!canContinue}
              onClick={continueToTicket}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition',
                canContinue
                  ? 'bg-blue-700 text-white hover:bg-blue-800'
                  : 'cursor-not-allowed bg-slate-200 text-slate-500',
              )}
            >
              Next <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
