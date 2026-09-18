import { useState } from 'react'
import { cn } from '@/lib/cn'
import { ClipboardCheck, AlertTriangle, X } from 'lucide-react'
import {
  getDeployChecklist,
  isFlaggedAnswer,
  TRI_ANSWERS,
  type DeployCategory,
  type DeployInspectionResult,
} from '@/lib/deployChecklist'

interface DeployInspectionModalProps {
  equipmentName: string
  serialNumber: string
  category: DeployCategory
  inspectedBy?: string | null
  onComplete: (result: DeployInspectionResult) => void
  onCancel: () => void
}

/**
 * #19/#20 Deploy QA gate — required inspection popped when a tech adds a piece
 * of gear to a rental job. Flagged answers (Needs Repair / Inoperable / No)
 * never block the deploy, but they require a note ("allow with required notes").
 */
export function DeployInspectionModal({
  equipmentName,
  serialNumber,
  category,
  inspectedBy,
  onComplete,
  onCancel,
}: DeployInspectionModalProps) {
  const checklist = getDeployChecklist(category)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [gasConfig, setGasConfig] = useState<string[]>([])
  const [notes, setNotes] = useState('')

  const allQuestions = checklist.sections.flatMap(s => s.questions)
  const allAnswered = allQuestions.every(q => !!answers[q.key])
  const configOk = !checklist.configOptions || gasConfig.length > 0
  const flagged = allQuestions.some(q => isFlaggedAnswer(answers[q.key] || ''))
  const notesOk = !flagged || !!notes.trim()
  const canComplete = allAnswered && configOk && notesOk

  function setAnswer(key: string, value: string) {
    setAnswers(prev => ({ ...prev, [key]: value }))
  }

  function complete() {
    if (!canComplete) return
    onComplete({
      category,
      answers,
      ...(checklist.configOptions ? { gasConfig } : {}),
      flagged,
      notes: notes.trim(),
      inspectedAt: new Date().toISOString(),
      inspectedBy: inspectedBy || null,
    })
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg my-8">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2.5 min-w-0">
            <ClipboardCheck className="w-5 h-5 text-blue-600 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-slate-900">{checklist.title}</h2>
              <p className="text-xs text-slate-500 truncate">
                {equipmentName} <span className="font-mono">{serialNumber}</span>
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-700 p-1 shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {checklist.sections.map(section => (
            <div key={section.key}>
              <h3 className="text-sm font-semibold text-slate-800 mb-2">{section.title}</h3>
              <div className="space-y-2">
                {section.questions.map(q => (
                  <div key={q.key} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-slate-700 flex-1 min-w-0">{q.label}</span>
                    <div className="flex gap-1 shrink-0">
                      {q.kind === 'tri' ? (
                        TRI_ANSWERS.map(opt => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => setAnswer(q.key, opt.value)}
                            className={cn(
                              'px-2 py-1.5 rounded text-[11px] font-medium border transition-colors',
                              answers[q.key] === opt.value
                                ? opt.flagged
                                  ? 'bg-red-100 border-red-300 text-red-800'
                                  : 'bg-green-100 border-green-300 text-green-800'
                                : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300',
                            )}
                          >
                            {opt.label}
                          </button>
                        ))
                      ) : (
                        (['yes', 'no'] as const).map(v => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setAnswer(q.key, v)}
                            className={cn(
                              'px-3 py-1.5 rounded text-xs font-medium border transition-colors',
                              answers[q.key] === v
                                ? v === 'yes'
                                  ? 'bg-green-100 border-green-300 text-green-800'
                                  : 'bg-red-100 border-red-300 text-red-800'
                                : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300',
                            )}
                          >
                            {v === 'yes' ? 'Yes' : 'No'}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Gas configuration — multi-select, any combo */}
          {checklist.configOptions && (
            <div>
              <h3 className="text-sm font-semibold text-slate-800 mb-2">
                How is it configured? <span className="font-normal text-slate-400 text-xs">— select all that apply</span>
              </h3>
              <div className="flex gap-2 flex-wrap">
                {checklist.configOptions.map(opt => {
                  const on = gasConfig.includes(opt.key)
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setGasConfig(prev => on ? prev.filter(k => k !== opt.key) : [...prev, opt.key])}
                      className={cn(
                        'px-3 py-2 rounded-lg text-sm font-medium border-2 transition-colors',
                        on
                          ? 'border-blue-500 bg-blue-50 text-blue-800'
                          : 'border-slate-200 text-slate-500 hover:border-slate-300',
                      )}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Notes — required when anything is flagged */}
          {flagged && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span className="text-sm font-semibold text-amber-900">
                  Flagged items — explain before deploying
                </span>
              </div>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                placeholder="What's wrong, and why is it still going out? (required)"
                className={cn(
                  'w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-500 resize-none',
                  notes.trim() ? 'border-slate-300' : 'border-amber-300 bg-white',
                )}
              />
            </div>
          )}
          {!flagged && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Notes</label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Optional notes"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          <p className="text-xs text-slate-400">
            {!allAnswered ? 'Answer every item to continue'
              : !configOk ? 'Pick at least one configuration'
              : !notesOk ? 'A note is required for flagged items'
              : flagged ? 'Deploying with flagged items — noted' : 'All clear'}
          </p>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              onClick={complete}
              disabled={!canComplete}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50',
                flagged ? 'bg-amber-600 hover:bg-amber-500' : 'bg-blue-700 hover:bg-blue-600',
              )}
            >
              {flagged ? 'Deploy Anyway' : 'Add to Job'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
