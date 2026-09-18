import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { getActiveSiteId } from '@/lib/site'
import { Printer, Plus, Minus } from 'lucide-react'

type PrinterOption = { id: string; name: string; active: boolean; defaultForStation: string | null }

// One row in the per-unit label checklist. Children (SCBA components) carry
// their parent's serial so the row previews the "PART OF <case serial>" line
// the label will print.
export type LabelUnit = {
  itemId: string
  serial: string
  description: string | null
  parentSerial: string | null
}

/**
 * Flatten a WO API response (top-level items with nested childComponents)
 * into checklist rows — one per unit, components right after their parent.
 */
export function collectLabelUnits(wo: any): LabelUnit[] {
  const units: LabelUnit[] = []
  for (const it of wo?.items ?? []) {
    units.push({
      itemId: it.id,
      serial: it.serialNumber,
      description: it.equipmentDescription || null,
      parentSerial: null,
    })
    for (const child of it.childComponents ?? []) {
      units.push({
        itemId: child.id,
        serial: child.serialNumber,
        description: child.equipmentDescription || null,
        parentSerial: it.serialNumber,
      })
    }
  }
  return units
}

interface ShopLabelPrintDialogProps {
  woId: string
  /** Per-unit label rows; all start checked. Each prints its own serial (+ "PART OF <parent>" for components). */
  units: LabelUnit[]
  /** Order-level "<N> PCS" packet/bin labels on top of the unit labels (default 2). */
  defaultPacketCopies?: number
  title?: string
  /** Called after a successful print or on Skip. */
  onDone: () => void
}

/**
 * "Print labels?" confirm dialog for a shop work order — picks a printer at
 * the active site (pre-selecting the intake default) and enqueues one per-unit
 * label per checked row plus N packet labels via POST /shop-orders/:id/labels.
 * Printing must never trap the operator: errors surface but Skip is always
 * available.
 */
export function ShopLabelPrintDialog({
  woId,
  units,
  defaultPacketCopies = 2,
  title = 'Print intake labels?',
  onDone,
}: ShopLabelPrintDialogProps) {
  const [printers, setPrinters] = useState<PrinterOption[]>([])
  const [selectedPrinterId, setSelectedPrinterId] = useState('')
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set(units.map(u => u.itemId)))
  const [packetCopies, setPacketCopies] = useState(Math.max(0, defaultPacketCopies))
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const siteId = getActiveSiteId()
    api.get<{ data: PrinterOption[] }>(
      `/printers?active=true${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ''}`,
    )
      .then(res => {
        const list = res?.data ?? []
        setPrinters(list)
        const def = list.find(p => p.defaultForStation === 'intake') ?? list[0]
        if (def) setSelectedPrinterId(def.id)
      })
      .catch(() => {
        // Leave the list empty — the dialog shows the no-printer message.
      })
  }, [])

  function toggleUnit(itemId: string) {
    setCheckedIds(prev => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const totalLabels = checkedIds.size + packetCopies

  async function confirmPrint() {
    if (!selectedPrinterId || totalLabels === 0) return
    setPrinting(true)
    setError('')
    try {
      await api.post(`/shop-orders/${woId}/labels`, {
        printerId: selectedPrinterId,
        itemIds: units.filter(u => checkedIds.has(u.itemId)).map(u => u.itemId),
        copies: packetCopies,
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue labels')
      setPrinting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg p-5 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-3">
          <Printer className="w-5 h-5 text-blue-700" />
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        </div>

        {printers.length === 0 ? (
          <p className="text-sm text-slate-600 mb-4">
            No active printer at this shop. You can print later from the work order.
          </p>
        ) : (
          <>
            <label className="text-xs font-medium text-slate-500 block mb-1">Printer</label>
            <select
              value={selectedPrinterId}
              onChange={e => setSelectedPrinterId(e.target.value)}
              className="w-full mb-3 px-2 py-1.5 text-sm border border-slate-300 rounded"
            >
              {printers.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.defaultForStation === 'intake' ? ' (default)' : ''}
                </option>
              ))}
            </select>

            {units.length > 0 && (
              <>
                <label className="text-xs font-medium text-slate-500 block mb-1">
                  Unit labels — one per checked item
                </label>
                <div className="max-h-48 overflow-y-auto border border-slate-200 rounded mb-3 divide-y divide-slate-100">
                  {units.map(u => (
                    <label
                      key={u.itemId}
                      className={`flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-slate-50 ${u.parentSerial ? 'pl-6' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checkedIds.has(u.itemId)}
                        onChange={() => toggleUnit(u.itemId)}
                        className="rounded border-slate-300"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="font-medium text-slate-800">S/N {u.serial}</span>
                        {u.description && <span className="text-slate-500"> · {u.description}</span>}
                        {u.parentSerial && (
                          <span className="block text-xs text-slate-400">part of {u.parentSerial}</span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            <label className="text-xs font-medium text-slate-500 block mb-1">Extra packet/bin labels</label>
            <div className="flex items-center gap-2 mb-3">
              <button
                type="button"
                onClick={() => setPacketCopies(c => Math.max(0, c - 1))}
                className="w-9 h-9 flex items-center justify-center border border-slate-300 rounded text-slate-600 hover:bg-slate-50"
              >
                <Minus className="w-4 h-4" />
              </button>
              <input
                type="number"
                min="0"
                max="50"
                value={packetCopies}
                onChange={e => setPacketCopies(Math.max(0, Math.min(parseInt(e.target.value, 10) || 0, 50)))}
                className="w-16 text-center px-2 py-1.5 text-sm border border-slate-300 rounded"
              />
              <button
                type="button"
                onClick={() => setPacketCopies(c => Math.min(50, c + 1))}
                className="w-9 h-9 flex items-center justify-center border border-slate-300 rounded text-slate-600 hover:bg-slate-50"
              >
                <Plus className="w-4 h-4" />
              </button>
              <span className="text-xs text-slate-400">labels</span>
            </div>
          </>
        )}

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onDone}
            className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900"
          >
            Skip
          </button>
          {printers.length > 0 && (
            <button
              onClick={confirmPrint}
              disabled={printing || !selectedPrinterId || totalLabels === 0}
              className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {printing ? 'Printing…' : `Print ${totalLabels}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
