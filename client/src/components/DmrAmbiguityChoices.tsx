import { Link2, PlusCircle } from 'lucide-react'

interface Candidate {
  id: string; wellName: string | null; exact: boolean
  padName: string | null; fieldName: string | null; operatorName: string | null
}
type Resolution = { action: 'link'; wellId: string } | { action: 'create' }

export function DmrAmbiguityChoices({ candidates, chosen, onChange }: {
  candidates: Candidate[]; chosen?: Resolution; onChange: (resolution: Resolution) => void
}) {
  return <div className="mt-1.5 space-y-1">
    {candidates.map(candidate => {
      const selected = chosen?.action === 'link' && chosen.wellId === candidate.id
      return <button type="button" key={candidate.id} onClick={() => onChange({ action: 'link', wellId: candidate.id })}
        className={`w-full flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs border ${selected ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
        <span className="min-w-0 truncate">
          <span className="font-medium text-slate-800">{candidate.wellName}</span>
          {candidate.exact && <span className="ml-1 text-green-600 font-medium">exact name match</span>}
          <span className="text-slate-400"> · {candidate.padName || candidate.fieldName || 'unattached'} · {candidate.operatorName || 'no operator'}</span>
        </span>
        <span className={`inline-flex items-center gap-1 shrink-0 ${selected ? 'text-blue-600' : 'text-slate-400'}`}><Link2 className="w-3 h-3" /> Same well</span>
      </button>
    })}
    <button type="button" onClick={() => onChange({ action: 'create' })}
      className={`w-full flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs border ${chosen?.action === 'create' ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
      <span className="text-slate-600">None of these — different well</span>
      <span className={`inline-flex items-center gap-1 shrink-0 ${chosen?.action === 'create' ? 'text-blue-600' : 'text-slate-400'}`}><PlusCircle className="w-3 h-3" /> Create new</span>
    </button>
  </div>
}
