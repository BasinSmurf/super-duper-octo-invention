import { HelpTip } from '@/components/HelpTip'
import { cn } from '@/lib/cn'
import { QB_CLASS_PREVIEW, qbClassPreview, type QbDivision } from '@/lib/qbDivision'

// ADR-0017: the division rides the wizard path, so this component is normally
// LOCKED (fixedDivision) and the only thing the tech touches is the location
// of service (Williston vs Dickinson). The free D3/D4 picker survives as the
// legacy fallback for /tickets/new reached without a division.
export type Division = QbDivision | null

interface DivisionSelectorProps {
  division: Division
  isDickinson: boolean
  onChange: (division: Division, isDickinson: boolean) => void
  // When set, the division is locked (no D3/D4 picker) and only the location
  // of service is shown — which is the normal case now that the wizard path
  // stamps the division. Divisions with no Dickinson child class in QB (D7/D8
  // — Occ Health) show no location choice at all.
  fixedDivision?: QbDivision
}

const INTERNAL_HINT = (
  <span className="ml-2 text-xs font-normal text-slate-500">internal — does not appear on customer invoice</span>
)

// Williston is the default branch (isDickinson = false); the two buttons are
// just the one boolean shown as an explicit either/or.
function LocationOfService({ isDickinson, onSelect }: { isDickinson: boolean; onSelect: (isDickinson: boolean) => void }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-2">
        Location of Service (select one) <HelpTip text="Choose the branch this work belongs to: Williston or Dickinson." />
        {INTERNAL_HINT}
      </label>
      <div className="grid grid-cols-2 gap-2 sm:max-w-xs">
        {([['Williston', false], ['Dickinson', true]] as const).map(([label, value]) => (
          <button
            key={label}
            type="button"
            onClick={() => onSelect(value)}
            aria-pressed={isDickinson === value}
            className={cn(
              'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
              isDickinson === value
                ? 'border-blue-500 bg-blue-50 text-blue-800'
                : 'border-slate-200 text-slate-600 hover:border-slate-300',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function DivisionSelector({ division, isDickinson, onChange, fixedDivision }: DivisionSelectorProps) {
  // Locked mode: division is pinned (e.g. Field Inspection → D6). Only the
  // location of service is offered.
  if (fixedDivision) {
    const hasDickinson = QB_CLASS_PREVIEW[fixedDivision].dickinson != null
    const preview = qbClassPreview(fixedDivision, isDickinson)
    return (
      <div>
        {/* Company-wide divisions (D7/D8) have no Dickinson class — no choice. */}
        {hasDickinson && (
          <LocationOfService isDickinson={isDickinson} onSelect={v => onChange(fixedDivision, v)} />
        )}
        <p className="mt-2 text-xs text-slate-500">
          QB Class: <span className="font-mono text-slate-700">{preview}</span>
        </p>
      </div>
    )
  }

  // Unlocked mode only ever offers D3/D4, so that's all it previews.
  const previewable = division === 'D3' || division === 'D4' ? division : null
  const preview = qbClassPreview(previewable, isDickinson)

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-2">
          Division <span className="text-red-500">*</span> <HelpTip text="Choose the division responsible for this work." />
          {INTERNAL_HINT}
        </label>
        <div className="grid grid-cols-2 gap-2 sm:max-w-xs">
          {(['D3', 'D4'] as const).map(d => (
            <button
              key={d}
              type="button"
              onClick={() => onChange(d, isDickinson)}
              className={cn(
                'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                division === d
                  ? 'border-blue-500 bg-blue-50 text-blue-800'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300',
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <LocationOfService isDickinson={isDickinson} onSelect={v => onChange(division, v)} />
      {preview && (
        <p className="text-xs text-slate-500">
          QB Class: <span className="font-mono text-slate-700">{preview}</span>
        </p>
      )}
    </div>
  )
}
