import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { hasPermission } from '@/lib/permissions'
import { formatCalendarDateNumeric, calendarDateKey, localDateKey } from '@/lib/dates'
import { CustomerSearch } from '@/components/CustomerSearch'
import { EquipmentProductPicker } from '@/components/EquipmentProductPicker'
import { ScbaAssemblyFields, type ScbaAssemblyDraft } from '@/components/ScbaAssemblyFields'
import { ScbaAssemblyEditor } from '@/components/ScbaAssemblyEditor'
import {
  ArrowLeft, Wrench, Layers, Pencil, X, Check, Loader2, Trash2,
  Search, Plus, Package, ChevronRight, ChevronDown, Calendar, MapPin,
  Clock, QrCode, Printer as PrinterIcon, Download, ShieldCheck, AlertTriangle,
} from 'lucide-react'

// ---- Types ----

interface NovaraScheduleState {
  scheduleId: string
  name: string | null
  status: string | null
  expiresOn: string | null
  expiringOn: string | null
  lastCompletedOn: string | null
}

interface EquipmentDetail {
  id: string
  serialNumber: string
  customData?: { scba?: { durationMinutes: 5 | 30; posiCheckDate: string | null } }
  childEquipment?: Array<{ serialNumber: string; lastCalibrationDate: string | null; customData?: { scbaComponent?: string } | null }>
  ownership: string
  status: string
  productId: string
  product: { id: string; partNumber: string; name: string; category: string; isAssembly: boolean; isSerialized: boolean }
  currentCustomer: { id: string; name: string } | null
  currentCustomerId: string | null
  currentPad: { id: string; name: string } | null
  currentPadId: string | null
  currentWell: { id: string; wellName: string } | null
  currentWellId: string | null
  currentFacility: { id: string; name: string } | null
  currentFacilityId: string | null
  currentRental: { id: string; agreementNumber: string; status: string } | null
  parentEquipment: { id: string; serialNumber: string; product: { name: string } } | null
  parentEquipmentId: string | null
  calibrationDueDate: string | null
  lastCalibrationDate: string | null
  bumpTestDueDate: string | null
  purchaseDate: string | null
  warrantyExpiry: string | null
  safeCoreSerial: string | null
  conditionNotes: string | null
  condemnedAt: string | null
  condemnReason: string | null
  // Novara Flex mirror — read-only here on purpose. The sync overwrites all of
  // this every tick, so an edit box would just be a lie with a Save button.
  novaraEquipmentId: string | null
  novaraStatus: string | null
  novaraExpiresOn: string | null
  novaraExpiringOn: string | null
  novaraLastCompletedOn: string | null
  novaraInService: boolean | null
  novaraServiceHold: boolean
  novaraSchedules: NovaraScheduleState[] | null
  novaraSyncedAt: string | null
  _count: {
    childEquipment: number
    lineItemsInstalled: number
    lineItemsRemoved: number
    rentalAgreementItems: number
    repairOrders: number
    shopWorkOrderItems: number
  }
}

interface ChildEquipment {
  id: string
  serialNumber: string
  status: string
  product: { id: string; partNumber: string; name: string; category: string; isAssembly?: boolean }
  _count?: { childEquipment: number }
}

interface SearchResult {
  id: string
  serialNumber: string
  status: string
  product: { id: string; partNumber: string; name: string; category: string; isAssembly?: boolean }
}

interface HistoryData {
  tickets: any[]
  shopOrders: any[]
  rentals: any[]
  repairs: any[]
}

const STATUS_COLORS: Record<string, string> = {
  available: 'bg-green-100 text-green-700',
  deployed: 'bg-blue-100 text-blue-700',
  rented: 'bg-purple-100 text-purple-700',
  repair: 'bg-amber-100 text-amber-700',
  in_transit: 'bg-cyan-100 text-cyan-700',
  lost: 'bg-red-100 text-red-700',
  retired: 'bg-slate-200 text-slate-500',
  out_of_service: 'bg-orange-100 text-orange-700',
  condemned: 'bg-red-200 text-red-800',
}

const STATUS_OPTIONS = ['available', 'deployed', 'rented', 'repair', 'in_transit', 'lost', 'retired', 'out_of_service', 'condemned']
const OWNERSHIP_OPTIONS = [
  { value: 'basin_safety', label: 'Basin Safety' },
  { value: 'customer_owned', label: 'Customer Owned' },
]

function isMonitor(category: string): boolean {
  return category === 'monitor_personal' || category === 'monitor_area'
}

// Cylinders use Hydro/UE testing terminology instead of "calibration".
// Detected as a supplied-air component whose product name reads as a bottle/cylinder.
function isCylinder(product: { category: string; name: string; partNumber?: string }): boolean {
  if (product.category !== 'supplied_air_component') return false
  const hay = `${product.name} ${product.partNumber ?? ''}`.toLowerCase()
  return hay.includes('cylinder') || hay.includes('bottle')
}

// Every date on this page is a calendar date (SerializedEquipment's
// calibration / purchase / warranty fields are all @db.Date), so both of these
// go through the UTC-safe helpers.
function formatDate(d: string | null): string {
  return formatCalendarDateNumeric(d)
}

const toDateInput = calendarDateKey

function scbaDraft(equipment: EquipmentDetail): ScbaAssemblyDraft {
  const regulator = equipment.childEquipment?.find(c => c.customData?.scbaComponent === 'regulator')
  const tank = equipment.childEquipment?.find(c => c.customData?.scbaComponent === 'tank')
  return { durationMinutes: equipment.customData?.scba?.durationMinutes || 5, caseId: equipment.serialNumber,
    regulatorSerial: regulator?.serialNumber || '', tankSerial: tank?.serialNumber || '',
    posiCheckDate: equipment.customData?.scba?.posiCheckDate || '', hydroDate: toDateInput(tank?.lastCalibrationDate || null) }
}

export function EquipmentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const canEdit = hasPermission(user?.role, 'inventory:manage')

  const [equipment, setEquipment] = useState<EquipmentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingSection, setEditingSection] = useState<'info' | 'dates' | 'location' | null>(null)
  const [draft, setDraft] = useState<Record<string, any>>({})
  const [badgeOpen, setBadgeOpen] = useState(false)

  const loadEquipment = useCallback(async () => {
    try {
      const data = await api.get<EquipmentDetail>(`/equipment/${id}`)
      setEquipment(data)
    } catch {
      setError('Failed to load equipment')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { loadEquipment() }, [loadEquipment])

  function startEdit(section: 'info' | 'dates' | 'location') {
    if (!equipment) return
    if (section === 'info') {
      setDraft({
        serialNumber: equipment.serialNumber,
        safeCoreSerial: equipment.safeCoreSerial || '',
        ownership: equipment.ownership,
        status: equipment.status,
        conditionNotes: equipment.conditionNotes || '',
        product: equipment.product,
        productId: equipment.productId,
        scbaMode: equipment.customData?.scba?.durationMinutes ? String(equipment.customData.scba.durationMinutes) : 'catalog',
        scba: scbaDraft(equipment),
      })
    } else if (section === 'dates') {
      setDraft({
        calibrationDueDate: toDateInput(equipment.calibrationDueDate),
        lastCalibrationDate: toDateInput(equipment.lastCalibrationDate),
        bumpTestDueDate: toDateInput(equipment.bumpTestDueDate),
        purchaseDate: toDateInput(equipment.purchaseDate),
        warrantyExpiry: toDateInput(equipment.warrantyExpiry),
      })
    } else if (section === 'location') {
      setDraft({
        currentCustomerId: equipment.currentCustomerId,
        currentCustomer: equipment.currentCustomer,
        currentPadId: equipment.currentPadId,
        currentPadName: equipment.currentPad?.name || '',
        currentWellId: equipment.currentWellId,
        currentWellName: equipment.currentWell?.wellName || '',
        currentFacilityId: equipment.currentFacilityId,
        currentFacilityName: equipment.currentFacility?.name || '',
      })
    }
    setEditingSection(section)
  }

  async function saveSection() {
    if (!equipment || !editingSection) return
    setSaving(true)
    setError('')
    try {
      const payload: Record<string, any> = {}
      if (editingSection === 'info') {
        payload.serialNumber = draft.serialNumber
        payload.safeCoreSerial = draft.safeCoreSerial || null
        payload.ownership = draft.ownership
        payload.status = draft.status
        payload.conditionNotes = draft.conditionNotes || null
        payload.productId = draft.productId
      } else if (editingSection === 'dates') {
        for (const f of ['calibrationDueDate', 'lastCalibrationDate', 'bumpTestDueDate', 'purchaseDate', 'warrantyExpiry']) {
          payload[f] = draft[f] ? new Date(draft[f]).toISOString() : null
        }
      } else if (editingSection === 'location') {
        payload.currentCustomerId = draft.currentCustomerId || null
        payload.currentPadId = draft.currentPadId || null
        payload.currentWellId = draft.currentWellId || null
        payload.currentFacilityId = draft.currentFacilityId || null
      }
      if (editingSection === 'info' && draft.scbaMode !== 'catalog') {
        await api.put(`/equipment/${id}/scba`, { ...payload, ...draft.scba, durationMinutes: Number(draft.scbaMode) })
      } else await api.put(`/equipment/${id}`, payload)
      setEditingSection(null)
      await loadEquipment()
    } catch (err: any) {
      setError(err?.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleRetire() {
    if (!confirm('Retire this equipment? It will be marked as retired and unassigned from all locations.')) return
    setSaving(true)
    try {
      await api.delete(`/equipment/${id}`)
      await loadEquipment()
    } catch (err: any) {
      setError(err?.message || 'Failed to retire')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>
  if (!equipment) return <div className="text-center py-12 text-red-500">{error || 'Equipment not found'}</div>

  const totalHistory = equipment._count.lineItemsInstalled + equipment._count.lineItemsRemoved +
    equipment._count.rentalAgreementItems + equipment._count.repairOrders + equipment._count.shopWorkOrderItems

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-3 mb-6">
        <button onClick={() => navigate('/equipment')} className="mt-1 p-1.5 rounded-lg hover:bg-slate-100">
          <ArrowLeft className="w-5 h-5 text-slate-500" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold text-slate-900 font-mono">{equipment.serialNumber}</h1>
            {equipment.product.isAssembly && (
              <span className="px-2 py-0.5 text-xs font-bold bg-indigo-100 text-indigo-700 rounded">ASSEMBLY</span>
            )}
            <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', STATUS_COLORS[equipment.status] || 'bg-slate-100')}>
              {equipment.status.replace(/_/g, ' ')}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-0.5">{equipment.product.name}</p>
          {equipment.parentEquipment && (
            <Link
              to={`/equipment/${equipment.parentEquipment.id}`}
              className="text-xs text-indigo-600 hover:underline flex items-center gap-1 mt-1"
            >
              <Layers className="w-3 h-3" />
              Part of {equipment.parentEquipment.serialNumber} ({equipment.parentEquipment.product.name})
            </Link>
          )}
        </div>
        <button
          onClick={() => setBadgeOpen(true)}
          className="px-3 py-1.5 text-sm text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 flex items-center gap-1.5"
        >
          <QrCode className="w-3.5 h-3.5" />
          Badge
        </button>
        {canEdit && equipment.status !== 'retired' && (
          <button
            onClick={handleRetire}
            disabled={saving}
            className="px-3 py-1.5 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Retire
          </button>
        )}
      </div>

      {badgeOpen && (
        <EquipmentBadgeDialog
          equipmentId={equipment.id}
          serialNumber={equipment.serialNumber}
          onClose={() => setBadgeOpen(false)}
        />
      )}

      {equipment.status === 'condemned' && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm font-semibold text-red-800">Decommissioned — condemned</p>
          {equipment.condemnReason && (
            <p className="text-sm text-red-700 mt-0.5">{equipment.condemnReason}</p>
          )}
          {equipment.condemnedAt && (
            <p className="text-xs text-red-600 mt-1">
              Condemned {new Date(equipment.condemnedAt).toLocaleDateString()}
            </p>
          )}
        </div>
      )}

      {error && <div className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg">{error}</div>}

      <div className="space-y-4">
        {/* Section 1: Equipment Info */}
        <SectionCard
          title="Equipment Info"
          icon={<Wrench className="w-4 h-4" />}
          editing={editingSection === 'info'}
          canEdit={canEdit}
          onEdit={() => startEdit('info')}
          onCancel={() => setEditingSection(null)}
          onSave={saveSection}
          saving={saving}
        >
          {editingSection === 'info' ? (
            <div className="grid grid-cols-2 gap-4">
              {draft.scbaMode === 'catalog' && <Field label="Serial Number">
                <input
                  type="text"
                  value={draft.serialNumber || ''}
                  onChange={e => setDraft(d => ({ ...d, serialNumber: e.target.value, scba: { ...d.scba, caseId: e.target.value } }))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                />
              </Field>}
              <Field label="Product">
                <select aria-label="Product type" value={draft.scbaMode} onChange={e => setDraft(d => ({ ...d, scbaMode: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg mb-2">
                  <option value="catalog">Catalog product</option>
                  <option value="5">SCBA 5 min Pack — Assembly</option>
                  <option value="30">SCBA 30 min Pack — Assembly</option>
                </select>
                {draft.scbaMode === 'catalog' && <EquipmentProductPicker value={draft.product}
                  onChange={product => setDraft(d => ({ ...d, product, productId: product.id,
                    scbaMode: product.partNumber === 'SP-SCBA-5-PACK' ? '5' : product.partNumber === 'SP-SCBA-30-PACK' ? '30' : 'catalog' }))} />}
              </Field>
              {draft.scbaMode !== 'catalog' && <div className="col-span-2">
                <ScbaAssemblyFields value={draft.scba} onChange={scba => setDraft(d => ({ ...d, scba, serialNumber: scba.caseId }))} disabled={saving} />
              </div>}
              {isMonitor(equipment.product.category) && (
                <Field label="Safe Core Serial">
                  <input
                    type="text"
                    value={draft.safeCoreSerial || ''}
                    onChange={e => setDraft(d => ({ ...d, safeCoreSerial: e.target.value }))}
                    placeholder="Core serial number"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                  />
                </Field>
              )}
              <Field label="Ownership">
                <select
                  value={draft.ownership}
                  onChange={e => setDraft(d => ({ ...d, ownership: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  {OWNERSHIP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
              <Field label="Status">
                <select
                  value={draft.status}
                  onChange={e => setDraft(d => ({ ...d, status: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                </select>
              </Field>
              <div className="col-span-2">
                <Field label="Condition Notes">
                  <textarea
                    value={draft.conditionNotes || ''}
                    onChange={e => setDraft(d => ({ ...d, conditionNotes: e.target.value }))}
                    rows={3}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                </Field>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <InfoRow label={equipment.customData?.scba ? 'Case ID' : 'Serial Number'} value={equipment.serialNumber} mono />
              <InfoRow label="Part Number" value={equipment.product.partNumber} mono />
              <InfoRow label="Product" value={equipment.product.name} />
              <InfoRow label="Category" value={equipment.product.category.replace(/_/g, ' ')} />
              {isMonitor(equipment.product.category) && equipment.safeCoreSerial && (
                <InfoRow label="Safe Core Serial" value={equipment.safeCoreSerial} mono />
              )}
              <InfoRow label="Ownership" value={equipment.ownership.replace(/_/g, ' ')} />
              <InfoRow label="Status" value={equipment.status.replace(/_/g, ' ')} />
              {equipment.conditionNotes && (
                <div className="col-span-2">
                  <InfoRow label="Condition Notes" value={equipment.conditionNotes} />
                </div>
              )}
            </div>
          )}
        </SectionCard>

        {/* Section 2: Dates */}
        {equipment.customData?.scba && <ScbaAssemblyEditor equipmentId={equipment.id} initial={scbaDraft(equipment)} canEdit={canEdit} onSaved={loadEquipment} />}
        <SectionCard
          title="Dates"
          icon={<Calendar className="w-4 h-4" />}
          editing={editingSection === 'dates'}
          canEdit={canEdit}
          onEdit={() => startEdit('dates')}
          onCancel={() => setEditingSection(null)}
          onSave={saveSection}
          saving={saving}
        >
          {(() => {
            const cylinder = isCylinder(equipment.product)
            const dueLabel = equipment.customData?.scba ? 'Posi-check Due' : cylinder ? 'Hydro/UE Due' : 'Calibration Due'
            const lastLabel = cylinder ? 'Last Hydro/UE' : 'Last Calibration'
            return editingSection === 'dates' ? (
              <div className="grid grid-cols-2 gap-4">
                <Field label={dueLabel}>
                  <input type="date" value={draft.calibrationDueDate || ''} onChange={e => setDraft(d => ({ ...d, calibrationDueDate: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
                </Field>
                <Field label={lastLabel}>
                  <input type="date" value={draft.lastCalibrationDate || ''} onChange={e => setDraft(d => ({ ...d, lastCalibrationDate: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
                </Field>
                <Field label="Bump Test Due">
                  <input type="date" value={draft.bumpTestDueDate || ''} onChange={e => setDraft(d => ({ ...d, bumpTestDueDate: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
                </Field>
                <Field label="Purchase Date">
                  <input type="date" value={draft.purchaseDate || ''} onChange={e => setDraft(d => ({ ...d, purchaseDate: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
                </Field>
                <Field label="Warranty Expiry">
                  <input type="date" value={draft.warrantyExpiry || ''} onChange={e => setDraft(d => ({ ...d, warrantyExpiry: e.target.value }))} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
                </Field>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <DateRow label={dueLabel} value={equipment.calibrationDueDate} warn />
                <DateRow label={lastLabel} value={equipment.lastCalibrationDate} />
                <DateRow label="Bump Test Due" value={equipment.bumpTestDueDate} warn />
                <DateRow label="Purchase Date" value={equipment.purchaseDate} />
                <DateRow label="Warranty Expiry" value={equipment.warrantyExpiry} warn />
              </div>
            )
          })()}
        </SectionCard>

        {/* Section 2b: Novara compliance (only for units Novara knows about) */}
        {equipment.novaraEquipmentId && <NovaraComplianceCard equipment={equipment} />}

        {/* Section 3: Location / Assignment */}
        <SectionCard
          title="Location / Assignment"
          icon={<MapPin className="w-4 h-4" />}
          editing={editingSection === 'location'}
          canEdit={canEdit}
          onEdit={() => startEdit('location')}
          onCancel={() => setEditingSection(null)}
          onSave={saveSection}
          saving={saving}
        >
          {editingSection === 'location' ? (
            <LocationEditSection draft={draft} setDraft={setDraft} />
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <InfoRow
                label="Customer"
                value={equipment.currentCustomer?.name || '—'}
                link={equipment.currentCustomer ? `/companies/${equipment.currentCustomer.id}` : undefined}
              />
              <InfoRow label="Pad" value={equipment.currentPad?.name || '—'} />
              <InfoRow label="Well" value={equipment.currentWell?.wellName || '—'} />
              <InfoRow label="Facility" value={equipment.currentFacility?.name || '—'} />
              {equipment.currentRental && (
                <InfoRow
                  label="Rental Agreement"
                  value={equipment.currentRental.agreementNumber}
                  link={`/rentals/${equipment.currentRental.id}`}
                />
              )}
            </div>
          )}
        </SectionCard>

        {/* Section 4: Assembly Contents */}
        {equipment.product.isAssembly && (
          <AssemblySection key={equipment.childEquipment?.map(c => c.serialNumber).join('|')} equipmentId={equipment.id} onRefresh={loadEquipment} canEdit={canEdit} />
        )}

        {/* Section 5: Service History */}
        {totalHistory > 0 && (
          <ServiceHistorySection equipmentId={equipment.id} totalCount={totalHistory} />
        )}
      </div>
    </div>
  )
}

// ============================================================
// Shared UI Components
// ============================================================

function SectionCard({
  title, icon, editing, canEdit, onEdit, onCancel, onSave, saving, children,
}: {
  title: string
  icon: React.ReactNode
  editing: boolean
  canEdit: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
  saving: boolean
  children: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <h2 className="font-semibold text-slate-800 flex items-center gap-2">{icon}{title}</h2>
        {editing ? (
          <div className="flex items-center gap-2">
            <button onClick={onCancel} className="px-3 py-1 text-sm text-slate-500 hover:bg-slate-100 rounded-lg">Cancel</button>
            <button onClick={onSave} disabled={saving} className="px-3 py-1 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 flex items-center gap-1">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Save
            </button>
          </div>
        ) : canEdit ? (
          <button onClick={onEdit} className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg">
            <Pencil className="w-4 h-4" />
          </button>
        ) : null}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
      {children}
    </div>
  )
}

function InfoRow({ label, value, mono, link }: { label: string; value: string; mono?: boolean; link?: string }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      {link ? (
        <Link to={link} className="text-sm text-blue-600 hover:underline">{value}</Link>
      ) : (
        <p className={cn('text-sm text-slate-700', mono && 'font-mono')}>{value}</p>
      )}
    </div>
  )
}

function DateRow({ label, value, warn }: { label: string; value: string | null; warn?: boolean }) {
  const isPast = warn && value && new Date(value) < new Date()
  const isSoon = warn && value && !isPast && new Date(value) < new Date(Date.now() + 30 * 86400000)
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className={cn(
        'text-sm',
        isPast ? 'text-red-600 font-medium' : isSoon ? 'text-amber-600 font-medium' : 'text-slate-700',
      )}>
        {formatDate(value)}
        {isPast && <span className="ml-1 text-xs">(overdue)</span>}
        {isSoon && <span className="ml-1 text-xs">(soon)</span>}
      </p>
    </div>
  )
}

// ============================================================
// Location Edit Section
// ============================================================

function LocationEditSection({ draft, setDraft }: { draft: Record<string, any>; setDraft: React.Dispatch<React.SetStateAction<Record<string, any>>> }) {
  const [padSearch, setPadSearch] = useState('')
  const [padResults, setPadResults] = useState<{ id: string; name: string }[]>([])
  const [showPadResults, setShowPadResults] = useState(false)
  const [wellOptions, setWellOptions] = useState<{ id: string; wellName: string }[]>([])
  const [facilitySearch, setFacilitySearch] = useState('')
  const [facilityResults, setFacilityResults] = useState<{ id: string; name: string }[]>([])
  const [showFacilityResults, setShowFacilityResults] = useState(false)

  // Search pads
  useEffect(() => {
    if (padSearch.length < 2) { setPadResults([]); return }
    const timer = setTimeout(async () => {
      try {
        const res = await api.get<{ data: { id: string; name: string }[] }>(`/locations/pads?search=${encodeURIComponent(padSearch)}&limit=10`)
        setPadResults(res.data)
        setShowPadResults(true)
      } catch { setPadResults([]) }
    }, 250)
    return () => clearTimeout(timer)
  }, [padSearch])

  // Load wells when pad changes
  useEffect(() => {
    if (!draft.currentPadId) { setWellOptions([]); return }
    api.get<{ data: { id: string; wellName: string }[] }>(`/locations/wells?padId=${draft.currentPadId}&limit=100`)
      .then(res => setWellOptions(res.data))
      .catch(() => setWellOptions([]))
  }, [draft.currentPadId])

  // Search facilities
  useEffect(() => {
    if (facilitySearch.length < 2) { setFacilityResults([]); return }
    const timer = setTimeout(async () => {
      try {
        const res = await api.get<{ data: { id: string; name: string }[] }>(`/locations/facilities?search=${encodeURIComponent(facilitySearch)}&limit=10`)
        setFacilityResults(res.data)
        setShowFacilityResults(true)
      } catch { setFacilityResults([]) }
    }, 250)
    return () => clearTimeout(timer)
  }, [facilitySearch])

  return (
    <div className="space-y-4">
      {/* Customer */}
      <Field label="Customer">
        <CustomerSearch
          value={draft.currentCustomer || null}
          onChange={(company) => setDraft(d => ({ ...d, currentCustomerId: company?.id || null, currentCustomer: company }))}
        />
      </Field>

      {/* Pad */}
      <Field label="Pad">
        <div className="relative">
          {draft.currentPadId ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-700 flex-1">{draft.currentPadName}</span>
              <button onClick={() => { setDraft(d => ({ ...d, currentPadId: null, currentPadName: '', currentWellId: null, currentWellName: '' })); setPadSearch('') }} className="text-slate-400 hover:text-red-500">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <>
              <input
                type="text"
                value={padSearch}
                onChange={e => setPadSearch(e.target.value)}
                onFocus={() => padResults.length > 0 && setShowPadResults(true)}
                placeholder="Search pads..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
              {showPadResults && padResults.length > 0 && (
                <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                  {padResults.map(p => (
                    <button
                      key={p.id}
                      onClick={() => { setDraft(d => ({ ...d, currentPadId: p.id, currentPadName: p.name, currentWellId: null, currentWellName: '' })); setShowPadResults(false); setPadSearch('') }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </Field>

      {/* Well (depends on pad) */}
      {draft.currentPadId && wellOptions.length > 0 && (
        <Field label="Well">
          <select
            value={draft.currentWellId || ''}
            onChange={e => setDraft(d => ({ ...d, currentWellId: e.target.value || null }))}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          >
            <option value="">— None —</option>
            {wellOptions.map(w => <option key={w.id} value={w.id}>{w.wellName}</option>)}
          </select>
        </Field>
      )}

      {/* Facility */}
      <Field label="Facility">
        <div className="relative">
          {draft.currentFacilityId ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-700 flex-1">{draft.currentFacilityName}</span>
              <button onClick={() => { setDraft(d => ({ ...d, currentFacilityId: null, currentFacilityName: '' })); setFacilitySearch('') }} className="text-slate-400 hover:text-red-500">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <>
              <input
                type="text"
                value={facilitySearch}
                onChange={e => setFacilitySearch(e.target.value)}
                onFocus={() => facilityResults.length > 0 && setShowFacilityResults(true)}
                placeholder="Search facilities..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
              {showFacilityResults && facilityResults.length > 0 && (
                <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                  {facilityResults.map(f => (
                    <button
                      key={f.id}
                      onClick={() => { setDraft(d => ({ ...d, currentFacilityId: f.id, currentFacilityName: f.name })); setShowFacilityResults(false); setFacilitySearch('') }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50"
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </Field>
    </div>
  )
}

// ============================================================
// Assembly Build-Out Section (migrated from EquipmentPage panel)
// ============================================================

function AssemblySection({ equipmentId, onRefresh, canEdit }: { equipmentId: string; onRefresh: () => void; canEdit: boolean }) {
  const [children, setChildren] = useState<ChildEquipment[]>([])
  const [loadingChildren, setLoadingChildren] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [addQuery, setAddQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [showResults, setShowResults] = useState(false)
  const [adding, setAdding] = useState(false)

  // Drill-in stack for nested assemblies
  const [drillStack, setDrillStack] = useState<{ id: string; serialNumber: string; name: string }[]>([])
  const activeId = drillStack.length > 0 ? drillStack[drillStack.length - 1].id : equipmentId

  const loadChildren = useCallback(async (parentId: string) => {
    setLoadingChildren(true)
    try {
      const res = await api.get<{ data: ChildEquipment[] }>(`/equipment/${parentId}/children`)
      setChildren(res.data)
    } catch { setChildren([]) }
    finally { setLoadingChildren(false) }
  }, [])

  useEffect(() => { loadChildren(activeId) }, [activeId, loadChildren])

  // Search available equipment
  useEffect(() => {
    if (addQuery.length < 1) { setSearchResults([]); setShowResults(false); return }
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: addQuery, excludeParentId: activeId })
        const res = await api.get<{ data: SearchResult[] }>(`/equipment/search-available?${params}`)
        const childIds = new Set(children.map(c => c.id))
        setSearchResults(res.data.filter(r => !childIds.has(r.id)))
        setShowResults(true)
      } catch { setSearchResults([]) }
    }, 200)
    return () => clearTimeout(timer)
  }, [addQuery, activeId, children])

  function drillInto(child: ChildEquipment) {
    setDrillStack(prev => [...prev, { id: child.id, serialNumber: child.serialNumber, name: child.product.name }])
    setAddQuery(''); setShowResults(false)
  }

  function drillTo(index: number) {
    if (index < 0) setDrillStack([])
    else setDrillStack(prev => prev.slice(0, index + 1))
    setAddQuery(''); setShowResults(false)
  }

  async function handleAssign(childId: string) {
    setAdding(true); setError('')
    try {
      await api.post(`/equipment/${activeId}/children/assign`, { childIds: [childId] })
      setAddQuery(''); setShowResults(false)
      await loadChildren(activeId)
      onRefresh()
    } catch (err: any) { setError(err?.message || 'Failed to assign') }
    finally { setAdding(false) }
  }

  async function handleRemoveChild(childId: string) {
    setRemoving(childId); setError('')
    try {
      await api.delete(`/equipment/${activeId}/children/${childId}`)
      await loadChildren(activeId)
      onRefresh()
    } catch (err: any) { setError(err?.message || 'Failed to remove') }
    finally { setRemoving(null) }
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <h2 className="font-semibold text-slate-800 flex items-center gap-2">
          <Package className="w-4 h-4" />
          Assembly Contents
          <span className="text-xs font-normal text-slate-400">({children.length} items)</span>
        </h2>
      </div>
      <div className="p-4">
        {/* Breadcrumb */}
        {drillStack.length > 0 && (
          <div className="flex items-center gap-1 text-xs mb-3 flex-wrap">
            <button onClick={() => drillTo(-1)} className="text-blue-600 hover:underline font-mono">Root</button>
            {drillStack.map((entry, i) => (
              <span key={entry.id} className="flex items-center gap-1">
                <ChevronRight className="w-3 h-3 text-slate-400" />
                {i < drillStack.length - 1 ? (
                  <button onClick={() => drillTo(i)} className="text-blue-600 hover:underline font-mono">{entry.serialNumber}</button>
                ) : (
                  <span className="font-mono font-medium text-slate-700">{entry.serialNumber}</span>
                )}
              </span>
            ))}
          </div>
        )}

        {/* Search to add */}
        {canEdit && (
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={addQuery}
              onChange={e => setAddQuery(e.target.value)}
              onFocus={() => searchResults.length > 0 && setShowResults(true)}
              placeholder="Search available equipment to add..."
              className="w-full pl-8 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            {showResults && (
              <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {searchResults.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-slate-400 text-center">No available equipment found</p>
                ) : searchResults.map(r => (
                  <button
                    key={r.id}
                    onClick={() => handleAssign(r.id)}
                    disabled={adding}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 border-b border-slate-50 last:border-0 flex items-center gap-2 disabled:opacity-50"
                  >
                    <Plus className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="font-mono font-medium text-slate-900">{r.serialNumber}</span>
                      {r.product.isAssembly && <span className="ml-1.5 text-[9px] px-1 py-0.5 bg-indigo-100 text-indigo-700 rounded font-bold">ASSEMBLY</span>}
                      <span className="text-xs text-slate-500 ml-2">{r.product.name}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        {/* Children list */}
        {loadingChildren ? (
          <div className="text-center py-6 text-slate-400"><Loader2 className="w-5 h-5 animate-spin mx-auto mb-1" />Loading...</div>
        ) : children.length === 0 ? (
          <div className="text-center py-6 text-slate-400 border-2 border-dashed border-slate-200 rounded-lg">
            <Package className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No equipment assigned yet</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {children.map(child => (
              <div
                key={child.id}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2',
                  child.product.isAssembly ? 'bg-indigo-50 border border-indigo-100 cursor-pointer hover:bg-indigo-100' : 'bg-slate-50',
                )}
                onClick={child.product.isAssembly ? () => drillInto(child) : undefined}
              >
                {child.product.isAssembly && <Layers className="w-4 h-4 text-indigo-500 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Link
                      to={`/equipment/${child.id}`}
                      onClick={e => e.stopPropagation()}
                      className="text-sm font-mono font-medium text-slate-800 hover:text-blue-600 hover:underline"
                    >
                      {child.serialNumber}
                    </Link>
                    {child.product.isAssembly && (
                      <span className="px-1 py-0.5 text-[9px] font-bold bg-indigo-200 text-indigo-700 rounded">ASSEMBLY</span>
                    )}
                    {(child._count?.childEquipment ?? 0) > 0 && (
                      <span className="text-[10px] text-indigo-500">({child._count!.childEquipment})</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">{child.product.name}</p>
                </div>
                <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', STATUS_COLORS[child.status] || 'bg-slate-100')}>
                  {child.status.replace(/_/g, ' ')}
                </span>
                {child.product.isAssembly && <ChevronRight className="w-4 h-4 text-indigo-400 shrink-0" />}
                {canEdit && (
                  <button
                    onClick={e => { e.stopPropagation(); handleRemoveChild(child.id) }}
                    disabled={removing === child.id}
                    className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded disabled:opacity-50"
                    title="Remove"
                  >
                    {removing === child.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// Service History Section (lazy-loaded)
// ============================================================

function ServiceHistorySection({ equipmentId, totalCount }: { equipmentId: string; totalCount: number }) {
  const [expanded, setExpanded] = useState(false)
  const [history, setHistory] = useState<HistoryData | null>(null)
  const [loading, setLoading] = useState(false)

  async function loadHistory() {
    if (history) { setExpanded(e => !e); return }
    setExpanded(true)
    setLoading(true)
    try {
      const data = await api.get<HistoryData>(`/equipment/${equipmentId}/history`)
      setHistory(data)
    } catch { /* silently fail */ }
    finally { setLoading(false) }
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
      <button
        onClick={loadHistory}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 rounded-lg"
      >
        <h2 className="font-semibold text-slate-800 flex items-center gap-2">
          <Clock className="w-4 h-4" />
          Service History
          <span className="text-xs font-normal text-slate-400">({totalCount} records)</span>
        </h2>
        <ChevronDown className={cn('w-4 h-4 text-slate-400 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-slate-100">
          {loading ? (
            <div className="text-center py-4 text-slate-400"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
          ) : history ? (
            <div className="space-y-3 mt-3">
              {history.tickets.length > 0 && (
                <HistoryGroup title="Tickets" items={history.tickets.map(t => ({
                  key: t.id,
                  label: t.ticket?.ticketNumber || 'Unknown',
                  sublabel: `${t.lineType?.replace(/_/g, ' ')} — ${t.equipmentIdInstalled ? 'installed' : 'removed'}`,
                  date: t.ticket?.serviceDate
                    ? calendarDateKey(t.ticket.serviceDate)
                    : localDateKey(new Date(t.createdAt)),
                  link: t.ticket ? `/tickets/${t.ticket.id}` : undefined,
                  status: t.ticket?.status,
                }))} />
              )}
              {history.shopOrders.length > 0 && (
                <HistoryGroup title="Shop Orders" items={history.shopOrders.map(s => ({
                  key: s.id,
                  label: s.workOrder?.workOrderNumber || 'Unknown',
                  sublabel: s.serviceType?.replace(/_/g, ' ') || '',
                  date: localDateKey(new Date(s.createdAt)),
                  link: s.workOrder ? `/shop/${s.workOrder.id}` : undefined,
                  status: s.status,
                }))} />
              )}
              {history.rentals.length > 0 && (
                <HistoryGroup title="Rentals" items={history.rentals.map(r => ({
                  key: r.id,
                  label: r.rentalAgreement?.agreementNumber || 'Unknown',
                  sublabel: r.status?.replace(/_/g, ' ') || '',
                  date: calendarDateKey(r.deployedDate),
                  link: r.rentalAgreement ? `/rentals/${r.rentalAgreement.id}` : undefined,
                  status: r.rentalAgreement?.status,
                }))} />
              )}
              {history.repairs.length > 0 && (
                <HistoryGroup title="Repairs" items={history.repairs.map(r => ({
                  key: r.id,
                  label: r.repairNumber || 'Unknown',
                  sublabel: r.reportedIssue || '',
                  date: localDateKey(new Date(r.createdAt)),
                  status: r.status,
                }))} />
              )}
              {history.tickets.length === 0 && history.shopOrders.length === 0 && history.rentals.length === 0 && history.repairs.length === 0 && (
                <p className="text-sm text-slate-400 text-center py-2">No history records found</p>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function HistoryGroup({ title, items }: {
  title: string
  /** `date` is a plain YYYY-MM-DD key — calendar fields keep their stored
   *  day, instants are collapsed to the local day they happened on. */
  items: { key: string; label: string; sublabel: string; date: string; link?: string; status?: string }[]
}) {
  return (
    <div>
      <p className="text-xs font-medium text-slate-500 mb-1.5">{title}</p>
      <div className="space-y-1">
        {items.map(item => (
          <div key={item.key} className="flex items-center gap-2 text-sm bg-slate-50 rounded px-3 py-1.5">
            <div className="flex-1 min-w-0">
              {item.link ? (
                <Link to={item.link} className="font-medium text-blue-600 hover:underline">{item.label}</Link>
              ) : (
                <span className="font-medium text-slate-700">{item.label}</span>
              )}
              {item.sublabel && <span className="text-slate-400 ml-2 text-xs">{item.sublabel}</span>}
            </div>
            {item.status && (
              <span className="text-[10px] px-1.5 py-0.5 bg-slate-200 text-slate-600 rounded">{item.status.replace(/_/g, ' ')}</span>
            )}
            <span className="text-xs text-slate-400">{formatDate(item.date)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---- Badge dialog: download a QR PDF or reprint to a Zebra ----

interface BadgePrinter {
  id: string
  name: string
  active: boolean
  site?: { name: string; shortCode: string } | null
}

function EquipmentBadgeDialog({
  equipmentId, serialNumber, onClose,
}: {
  equipmentId: string
  serialNumber: string
  onClose: () => void
}) {
  const [printers, setPrinters] = useState<BadgePrinter[]>([])
  const [loadingPrinters, setLoadingPrinters] = useState(true)
  const [printerId, setPrinterId] = useState('')
  const [printing, setPrinting] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    api.get<{ data: BadgePrinter[] }>('/printers?active=true')
      .then(({ data }) => {
        setPrinters(data)
        if (data.length === 1) setPrinterId(data[0].id)
      })
      .catch(() => setPrinters([]))
      .finally(() => setLoadingPrinters(false))
  }, [])

  async function downloadPdf() {
    setDownloading(true)
    setMsg(null)
    try {
      const token = localStorage.getItem('sundog_token')
      const res = await fetch(`/api/equipment/${equipmentId}/badge.pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error('Badge PDF failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `badge-${serialNumber}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setMsg({ kind: 'err', text: e.message || 'Download failed' })
    } finally {
      setDownloading(false)
    }
  }

  async function printToZebra() {
    if (!printerId) return
    setPrinting(true)
    setMsg(null)
    try {
      const res = await api.post<{ printer: string; copies: number }>(
        `/equipment/${equipmentId}/print-label`, { printerId },
      )
      setMsg({ kind: 'ok', text: `Sent to ${res.printer}` })
    } catch (e: any) {
      setMsg({ kind: 'err', text: e.message || 'Print failed' })
    } finally {
      setPrinting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900 flex items-center gap-2">
            <QrCode className="w-4 h-4" /> Equipment badge
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-slate-500">
            QR badge for <span className="font-mono font-medium text-slate-700">{serialNumber}</span>.
            Scanning it adds this unit to a job.
          </p>

          {msg && (
            <div className={cn(
              'text-sm rounded-lg px-3 py-2',
              msg.kind === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600',
            )}>{msg.text}</div>
          )}

          {/* PDF — works on any printer / for laminating */}
          <button
            onClick={downloadPdf}
            disabled={downloading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50"
          >
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download PDF
          </button>

          {/* Zebra reprint */}
          <div className="pt-2 border-t border-slate-100">
            <label className="block text-xs font-medium text-slate-600 mb-1">Print to label printer</label>
            {loadingPrinters ? (
              <p className="text-sm text-slate-400">Loading printers…</p>
            ) : printers.length === 0 ? (
              <p className="text-sm text-slate-400">No label printers configured.</p>
            ) : (
              <div className="flex gap-2">
                <select
                  value={printerId}
                  onChange={e => setPrinterId(e.target.value)}
                  className="flex-1 min-w-0 px-2 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                >
                  <option value="">Select printer…</option>
                  {printers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.site ? ` (${p.site.shortCode})` : ''}
                    </option>
                  ))}
                </select>
                <button
                  onClick={printToZebra}
                  disabled={printing || !printerId}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <PrinterIcon className="w-4 h-4" />}
                  Print
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// Novara Compliance
// ============================================================
// Read-only mirror of Novara Flex, the system of record for whether a unit
// exists and whether its inspections are current. The sync overwrites every
// field below on each run, so this card shows rather than edits — fixes go
// into Novara. It only renders for units the sync has actually linked.

function NovaraComplianceCard({ equipment }: { equipment: EquipmentDetail }) {
  const status = equipment.novaraStatus
  const tone =
    status === 'expired' ? 'red'
    : status === 'expiring' ? 'amber'
    : status === 'uptodate' ? 'emerald'
    : 'slate'

  const badge = {
    red: 'bg-red-100 text-red-700 border-red-200',
    amber: 'bg-amber-100 text-amber-700 border-amber-200',
    emerald: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
  }[tone]

  const label = {
    expired: 'Expired',
    expiring: 'Expiring',
    uptodate: 'Up to date',
  }[status ?? ''] ?? 'Unknown'

  const schedules = equipment.novaraSchedules ?? []

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <h2 className="font-semibold text-slate-800 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          Novara Compliance
        </h2>
        <span className={cn('px-2 py-0.5 text-xs font-medium rounded-full border', badge)}>{label}</span>
      </div>

      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <DateRow label="Expires" value={equipment.novaraExpiresOn} warn />
          <DateRow label="Warning starts" value={equipment.novaraExpiringOn} />
          <DateRow label="Last completed" value={equipment.novaraLastCompletedOn} />
          <InfoRow
            label="Novara service state"
            value={equipment.novaraInService === null ? '—' : equipment.novaraInService ? 'In service' : 'Out of service'}
          />
        </div>

        {equipment.novaraServiceHold && (
          <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-800">
              This unit is out of service because Novara says so. It returns to Available
              automatically once Novara puts it back in service — changing the status here
              will be overwritten on the next sync.
            </p>
          </div>
        )}

        {schedules.length > 0 && (
          <div>
            <p className="text-xs font-medium text-slate-500 mb-2">Inspection schedules</p>
            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
              {schedules.map(s => (
                <div key={s.scheduleId} className="flex items-center justify-between px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-700 truncate">{s.name || 'Unnamed schedule'}</p>
                    <p className="text-xs text-slate-400">
                      {s.lastCompletedOn ? `Last done ${formatDate(s.lastCompletedOn)}` : 'Never completed'}
                    </p>
                  </div>
                  <div className="text-right shrink-0 pl-3">
                    <p className={cn(
                      'text-sm font-medium',
                      s.status === 'expired' ? 'text-red-600'
                        : s.status === 'expiring' ? 'text-amber-600'
                        : 'text-slate-700',
                    )}>
                      {s.status === 'expired' ? 'Expired' : s.status === 'expiring' ? 'Expiring' : 'Current'}
                    </p>
                    <p className="text-xs text-slate-400">{s.expiresOn ? formatDate(s.expiresOn) : 'no due date'}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-xs text-slate-400">
          {equipment.novaraSyncedAt
            ? `Synced from Novara ${formatCalendarDateNumeric(equipment.novaraSyncedAt)}`
            : 'Not yet synced'}
        </p>
      </div>
    </div>
  )
}
