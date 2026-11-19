export interface ScbaAssemblyDraft {
  durationMinutes: 5 | 30
  caseId: string
  regulatorSerial: string
  tankSerial: string
  posiCheckDate: string
  hydroDate: string
}

export const blankScbaAssembly = (): ScbaAssemblyDraft => ({
  durationMinutes: 5, caseId: '', regulatorSerial: '', tankSerial: '', posiCheckDate: '', hydroDate: '',
})

export function ScbaAssemblyFields({ value, onChange, disabled = false }: {
  value: ScbaAssemblyDraft; onChange: (value: ScbaAssemblyDraft) => void; disabled?: boolean
}) {
  return <div className="space-y-3">
    <p className="text-xs text-slate-500">The Case ID appears on the badge and its QR code. Regulator and tank serials are linked under this assembly.</p>
    <div className="grid grid-cols-2 gap-3">
      {([
        ['caseId', 'Case ID *', 'text'],
        ['regulatorSerial', 'Regulator Serial', 'text'],
        ['tankSerial', 'Tank Serial', 'text'],
        ['posiCheckDate', 'Posi-check (Pozi) Date', 'date'],
        ['hydroDate', 'Tank Hydro Date', 'date'],
      ] as const).map(([key, label, type]) => <label key={key} className="block text-sm font-medium text-slate-700">
        {label}
        <input aria-label={label} type={type} value={value[key]} disabled={disabled}
          onChange={e => onChange({ ...value, [key]: e.target.value })}
          className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg disabled:bg-slate-50" />
      </label>)}
    </div>
  </div>
}
