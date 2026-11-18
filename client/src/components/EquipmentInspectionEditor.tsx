import { ShopServicePicker, type ShopServiceCharge } from './ShopServicePicker'
import { SignaturePad } from './SignaturePad'
import { inspectionApproval } from '@/lib/inspectionApproval'
import { useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { db } from '@/lib/db'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import type {
  OfflineEquipmentInspection,
  OfflineEquipmentInspectionAttachment,
} from '@/lib/db-types'
import {
  getShopChecklist,
  getRequiredShopKeys,
  getMissingRequiredShopKeys,
  labelsForKeys,
  isQaChecklistComplete,
  itemApplies,
  evaluateCascades,
  extractCheckpointResults,
  type ChecklistItem,
  type Checkpoint,
  type CascadeAction,
} from '@/lib/inspectionChecklist'
import {
  X,
  Lock,
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FileWarning,
  Loader2,
  ShieldOff,
  Camera,
  Skull,
  Truck,
  Wrench,
  Paperclip,
  FileText,
  Trash2,
  Pencil,
} from 'lucide-react'

// Wave 1 — Equipment Inspection Form (unified shop + field).
// See project_inspection_forms_and_transfers.md for design context.
//
// Design notes:
//   - Self-contained modal. Talks to /api/equipment-inspections directly with
//     offline fallback to db.equipmentInspections + db.mutationQueue. Sync
//     engine drains the queue on next online cycle.
//   - Append-only: once lockedAt is set, the editor renders read-only with a
//     "File Correction" button that opens a new editor instance with
//     correctsId set, mirroring the schema's append-only contract.
//   - Category-discriminated sub-shapes. FEX / Gas / SCBA have rich shapes;
//     Fall Arrest / Breathing Air System are stubs pending real form schemas.
//   - Service action vocabulary mirrors server-side (`server/src/routes/equipmentInspections.ts`).
//     Validation lives at the API layer; the UI only shows the right options.

// ============================================================
// Types + vocabulary (mirror server)
// ============================================================

export type EquipmentInspectionCategory =
  | 'fire_extinguisher'
  | 'gas_detection'
  | 'scba'
  | 'fall_arrest'
  | 'ue_cylinder'
  | 'breathing_air_system'
  | 'first_aid_kit'
  | 'other'

export type InspectionOutcome =
  | 'pass'
  | 'fail'
  | 'condemn'
  | 'cannot_service'
  | 'requires_parts'

const CATEGORY_LABELS: Record<EquipmentInspectionCategory, string> = {
  fire_extinguisher: 'Fire Extinguisher',
  gas_detection: 'Gas Detection',
  scba: 'SCBA',
  fall_arrest: 'Fall Arrest',
  ue_cylinder: 'UE Cylinder',
  breathing_air_system: 'Breathing Air System',
  first_aid_kit: 'First Aid Kit',
  other: 'Other',
}

// Category-agnostic actions appended to every category. Keep in sync with
// COMMON_ACTIONS in server/src/routes/equipmentInspections.ts.
const COMMON_ACTIONS: Array<{ key: string; label: string }> = [
  { key: 'visual_only', label: 'Visual Only' },
  { key: 'other', label: 'Other' },
]

const SERVICE_ACTIONS: Record<EquipmentInspectionCategory, Array<{ key: string; label: string }>> = {
  fire_extinguisher: [
    { key: 'annual', label: 'Annual' },
    { key: 'recharge', label: 'Recharge' },
    { key: 'recharge_annual', label: 'Recharge + Annual' },
    { key: 'six_year', label: '6 Year' },
    { key: 'twelve_year_hydro', label: '12 Year Hydro' },
    { key: 'parts_replaced', label: 'Parts Replaced' },
    { key: 'condemn', label: 'Condemn' },
    { key: 'cannot_service', label: 'Cannot Service' },
    ...COMMON_ACTIONS,
  ],
  gas_detection: [
    { key: 'bump_test', label: 'Bump Test' },
    { key: 'calibration', label: 'Calibration' },
    { key: 'electronic_service', label: 'Electronic Service' },
    { key: 'sensor_replace', label: 'Sensor Replace' },
    { key: 'remove_from_service', label: 'Remove from Service' },
    { key: 'parts_replaced', label: 'Parts Replaced' },
    ...COMMON_ACTIONS,
  ],
  scba: [
    { key: 'air_fill_inspection', label: 'Air Fill Inspection' },
    { key: 'air_fill', label: 'Air Fill' },
    { key: 'flow_test', label: 'Flow Test' },
    { key: 'posi_check', label: 'Posi-Check' },
    { key: 'component_service', label: 'Component Service' },
    { key: 'mask_service', label: 'Mask Service' },
    { key: 'regulator_service', label: 'Regulator Service' },
    { key: 'parts_replaced', label: 'Parts Replaced' },
    ...COMMON_ACTIONS,
  ],
  ue_cylinder: [
    { key: 'ue_test', label: 'UE Test' },
    { key: 'hydro', label: 'Hydro' },
    { key: 'parts_replaced', label: 'Parts Replaced' },
    { key: 'condemn', label: 'Condemn' },
    ...COMMON_ACTIONS,
  ],
  // Fall Arrest sub-shape pending DeWalt fall-inspection form pull.
  fall_arrest: [...COMMON_ACTIONS],
  // Breathing Air System sub-shape TBD.
  breathing_air_system: [...COMMON_ACTIONS],
  first_aid_kit: [
    { key: 'restock', label: 'Restock' },
    { key: 'replace_expired', label: 'Replace Expired' },
    { key: 'general_inspection', label: 'General Inspection' },
    ...COMMON_ACTIONS,
  ],
  other: [...COMMON_ACTIONS],
}

// ============================================================
// QA CHECKLIST — the catalog + gate logic live in a single source of truth at
// server/src/services/inspectionChecklist.ts, mirrored here via codegen
// (client/src/lib/inspectionChecklist.ts — `npm run gen:checklist`). The shop
// editor renders the shop-scoped items; an item is "required" only when it
// applies given the service actions performed (see getRequiredShopKeys).
// ============================================================

/**
 * Thin wrapper kept for existing callers (e.g. ShopOrderDetailPage). Defers to
 * the shared gate so client and server can never disagree.
 */
export function qaChecklistComplete(
  category: EquipmentInspectionCategory,
  qaChecklist: Record<string, unknown> | undefined,
  serviceActions?: string[] | undefined,
): boolean {
  return isQaChecklistComplete(category, qaChecklist, serviceActions)
}

const OUTCOMES: Array<{ key: InspectionOutcome; label: string; tone: 'good' | 'warn' | 'bad' }> = [
  { key: 'pass', label: 'Pass', tone: 'good' },
  { key: 'fail', label: 'Fail', tone: 'warn' },
  { key: 'requires_parts', label: 'Requires Parts', tone: 'warn' },
  { key: 'cannot_service', label: 'Cannot Service', tone: 'bad' },
  { key: 'condemn', label: 'Condemn', tone: 'bad' },
]

// ============================================================
// Props
// ============================================================

export interface EquipmentInspectionEditorProps {
  // Parent context — exactly one populated. Mirrors schema CHECK constraint.
  shopItemId?: string
  /** Billing is captured during final QA, after the initial inspection. */
  shopPhase?: 'initial' | 'final'
  ticketId?: string
  // Equipment identity (snapshotted at inspection time)
  serializedEquipmentId?: string | null
  serialNumber: string
  category: EquipmentInspectionCategory
  /** Optional human-readable name for the header (e.g. "Amerex 5lb ABC") */
  equipmentDescription?: string
  /**
   * WI-07 — the constituent parts recorded at intake (SCBA case, regulator,
   * mask, harness, bottles), so the tech is not asked for what the counter
   * already wrote down. Each is a child unit record in its own right, which is
   * why correcting one edits that record rather than the inspection: a serial
   * mistyped at intake is wrong everywhere it appears, not just here.
   */
  intakeConstituents?: Array<{ id: string; label: string; serialNumber: string; notIncluded?: boolean }>
  /** Persist a constituent serial correction. Audited server-side. */
  onConstituentCorrected?: (childItemId: string, serialNumber: string) => Promise<void>
  onSerialCorrected?: (serialNumber: string) => Promise<void>
  /** When editing or filing a correction. */
  existing?: OfflineEquipmentInspection | null
  /** Set when filing a correction — the new record will reference the prior. */
  correctsId?: string
  /**
   * Capture-only mode (field wizard). The parent ticket doesn't exist yet, so
   * the editor must NOT persist (no API, no Dexie, no mutation queue) — it just
   * builds the in-memory record and hands it back via onSaved for the wizard to
   * persist at submit (after the ticket, so the ticketId FK + sync ID-remap
   * resolve). The Lock button is hidden; the wizard locks pass records at submit.
   */
  captureOnly?: boolean
  /**
   * Initial category sub-shape data for a NEW inspection (no `existing`), so a
   * single-unit inspection pre-fills what the work-order item already knows
   * (e.g. FEX brand / size / type) instead of re-asking. Ignored once `existing`
   * is present (a saved record's own data wins).
   */
  seedData?: Record<string, unknown>
  onSaved?: (record: OfflineEquipmentInspection) => void
  onClose: () => void
}

// ============================================================
// Attachments (condemn / cannot-service evidence + UE report PDF)
// ============================================================

interface AttachmentRow {
  id: string
  fileName: string
  fileType: 'photo' | 'document'
  mimeType?: string | null
  /** base64 or object-URL preview source (set for local + fetched images). */
  previewUrl?: string | null
  filePath?: string | null
  saved: boolean   // true once persisted (Dexie + queued); false = pending pre-save
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

// Fetch a server-stored file with the auth token and open it in a new tab.
async function openServerFile(filePath: string) {
  const token = localStorage.getItem('sundog_token')
  const res = await fetch(`/api/files/${filePath}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) return
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
}

// ============================================================
// Component
// ============================================================

export function EquipmentInspectionEditor(props: EquipmentInspectionEditorProps) {
  const showBilling = !!props.shopItemId && props.shopPhase === 'final'
  const isLocked = !!props.existing?.lockedAt
  const isCorrection = !!props.correctsId
  const isEditing = !!props.existing && !isLocked

  // Form state
  const [serviceActions, setServiceActions] = useState<string[]>(
    props.existing?.serviceActions ?? [],
  )
  const [billingServices, setBillingServices] = useState<ShopServiceCharge[]>([])
  const [servicesLoaded, setServicesLoaded] = useState(!showBilling)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!showBilling || isLocked) return
    let active = true
    api.get<{ services: ShopServiceCharge[] }>(`/shop-orders/service-billing/${props.shopItemId}`).then(r => {
      if (!active) return
      setBillingServices(r.services)
      const valid = SERVICE_ACTIONS[props.category].map(a => a.key)
      setServiceActions(prev => [...new Set([...prev, ...r.services.flatMap(s => s.serviceActions ?? []).filter(a => valid.includes(a))])])
      setServicesLoaded(true)
    }).catch(() => { if (active) setError('Could not load linked service charges. Reopen QA when connected.') })
    return () => { active = false }
  }, [props.shopItemId, props.category, isLocked, showBilling])

  const [outcome, setOutcome] = useState<InspectionOutcome>(
    (props.existing?.outcome as InspectionOutcome) ?? 'pass',
  )
  const [data, setData] = useState<Record<string, any>>(
    (props.existing?.data as Record<string, any>) ?? props.seedData ?? {},
  )
  const [partsReplaced, setPartsReplaced] = useState(props.existing?.partsReplaced ?? '')
  const [notes, setNotes] = useState(props.existing?.notes ?? '')
  const [customerApprovedName, setCustomerApprovedName] = useState(
    props.existing?.customerApprovedName ?? '',
  )
  const [customerApprovedSignature, setCustomerApprovedSignature] = useState<string | null>(props.existing?.customerApprovedSignature ?? null)

  // UI state
  const [saving, setSaving] = useState(false)
  const [locking, setLocking] = useState(false)
  const [showLockConfirm, setShowLockConfirm] = useState(false)
  const [showCorrectionEditor, setShowCorrectionEditor] = useState(false)
  const [serial, setSerial] = useState(props.serialNumber || props.existing?.serialNumber || '')
  const [serialConfirmed, setSerialConfirmed] = useState(false)
  const serialBlocked = !!props.shopItemId && (!serial.trim() || !serialConfirmed)

  async function persistShopSerial() {
    if (!props.shopItemId) return
    if (serialBlocked) throw new Error('Record and confirm the serial on this piece before saving QA.')
    if (serial.trim() !== props.serialNumber) {
      if (!props.onSerialCorrected) throw new Error('Save this piece’s serial on the work order before QA.')
      await props.onSerialCorrected(serial.trim())
    }
  }

  // ----- Attachments (condemn / cannot-service evidence + UE report PDF) -----
  const [attachments, setAttachments] = useState<AttachmentRow[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const docInputRef = useRef<HTMLInputElement | null>(null)
  // Show the attachment slot for condemn / cannot-service outcomes, or for any
  // UE cylinder inspection (the external report PDF). Not in field capture mode.
  const isUe = props.category === 'ue_cylinder'
  const showAttachments =
    !props.captureOnly && (outcome === 'condemn' || outcome === 'cannot_service' || isUe)

  // ----- QA gate, mirrored client-side -----
  //
  // Locking a `pass` inspection is what releases the unit: the server routes it
  // to shop_complete, the soft-close trigger stamps it, and 48 hours later it is
  // billable. The server refuses an incomplete checklist (and now refuses it on
  // the offline replay too), but a tech who only finds that out AFTER clicking
  // an irreversible-looking "Lock" has been failed by the UI. So the button
  // knows, and says which items are outstanding.
  //
  // Only `pass` is gated — every other outcome is recording a problem, not
  // certifying readiness, and is free to lock. Same rule as lockInspectionRecord.
  const qaBlockedKeys = useMemo(() => {
    if (props.captureOnly) return []
    if (outcome !== 'pass') return []
    return getMissingRequiredShopKeys(props.category, data.qaChecklist, serviceActions)
  }, [props.captureOnly, outcome, props.category, data.qaChecklist, serviceActions])
  const lockBlockedReason =
    serialBlocked ? 'Record and confirm the serial before locking QA (all outcomes).' : qaBlockedKeys.length > 0
      ? `Finish the QA checklist before locking a pass — still required: ${labelsForKeys(
          props.category,
          qaBlockedKeys,
        ).join('; ')}`
      : null

  // Load existing attachments for a saved inspection: local Dexie rows first
  // (instant, offline), then merge anything the server has (online).
  useEffect(() => {
    const inspectionId = props.existing?.id
    if (!inspectionId) return
    let cancelled = false
    ;(async () => {
      const local = await db.equipmentInspectionAttachments
        .where('inspectionId').equals(inspectionId).toArray().catch(() => [])
      const rows = new Map<string, AttachmentRow>()
      for (const a of local) {
        rows.set(a.id, {
          id: a.id, fileName: a.fileName, fileType: (a.fileType as 'photo' | 'document') || 'document',
          mimeType: a.mimeType, previewUrl: a.dataUrl ?? null, filePath: a.filePath ?? null, saved: true,
        })
      }
      try {
        const res = await api.get<{ attachments: Array<{ id: string; fileName: string; fileType: string; filePath: string | null; mimeType: string | null }> }>(
          `/equipment-inspections/${inspectionId}/attachments`,
        )
        for (const a of res.attachments) {
          const prev = rows.get(a.id)
          rows.set(a.id, {
            id: a.id, fileName: a.fileName, fileType: (a.fileType as 'photo' | 'document') || 'document',
            mimeType: a.mimeType, previewUrl: prev?.previewUrl ?? null, filePath: a.filePath, saved: true,
          })
        }
      } catch { /* offline — local rows are enough */ }
      if (!cancelled) setAttachments([...rows.values()])
    })()
    return () => { cancelled = true }
  }, [props.existing?.id])

  function makeAttachmentRow(file: File, dataUrl: string): AttachmentRow {
    const isImage = file.type.startsWith('image/')
    return {
      id: uuidv4(),
      fileName: file.name || (isImage ? 'photo.jpg' : 'file'),
      fileType: isImage ? 'photo' : 'document',
      mimeType: file.type || null,
      previewUrl: dataUrl,
      filePath: null,
      saved: false,
    }
  }

  // Persist one attachment: write the Dexie row + queue an upload mutation keyed
  // to the (now-known) inspection id. The sync engine decodes the dataUrl and
  // writes the file to storage. Mirrors the ticket-photo offline pattern.
  async function persistAttachment(inspectionId: string, row: AttachmentRow, dataUrl: string) {
    const now = new Date().toISOString()
    const record: OfflineEquipmentInspectionAttachment = {
      id: row.id, inspectionId, fileName: row.fileName, fileType: row.fileType,
      mimeType: row.mimeType ?? null, dataUrl, filePath: null, uploadedAt: now,
      _offlineStatus: 'pending',
    }
    await db.equipmentInspectionAttachments.put(record)
    await db.mutationQueue.add({
      table: 'equipmentInspectionAttachments',
      action: 'create',
      entityId: row.id,
      payload: { id: row.id, inspectionId, fileName: row.fileName, fileType: row.fileType, mimeType: row.mimeType ?? null, dataUrl, uploadedAt: now },
      createdAt: now,
      status: 'pending',
      retryCount: 0,
    })
  }

  // Holds dataUrls for pending (pre-save) attachments until the inspection id
  // exists, keyed by attachment id.
  const pendingData = useRef<Map<string, string>>(new Map())

  async function handleAddFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const newRows: AttachmentRow[] = []
    for (const file of Array.from(files)) {
      const dataUrl = await fileToDataUrl(file)
      const row = makeAttachmentRow(file, dataUrl)
      // If the inspection already exists, persist immediately; otherwise hold
      // until handleSave resolves the inspection id.
      if (props.existing?.id) {
        await persistAttachment(props.existing.id, row, dataUrl)
        row.saved = true
      } else {
        pendingData.current.set(row.id, dataUrl)
      }
      newRows.push(row)
    }
    setAttachments(prev => [...prev, ...newRows])
  }

  // Flush pending (pre-save) attachments once the inspection id is known.
  async function flushPendingAttachments(inspectionId: string) {
    for (const row of attachments) {
      if (row.saved) continue
      const dataUrl = pendingData.current.get(row.id)
      if (!dataUrl) continue
      await persistAttachment(inspectionId, row, dataUrl)
      pendingData.current.delete(row.id)
    }
  }

  async function removeAttachment(row: AttachmentRow) {
    if (row.saved) {
      const now = new Date().toISOString()
      await db.equipmentInspectionAttachments.delete(row.id).catch(() => {})
      await db.mutationQueue.add({
        table: 'equipmentInspectionAttachments', action: 'delete', entityId: row.id,
        payload: { id: row.id }, createdAt: now, status: 'pending', retryCount: 0,
      })
    } else {
      pendingData.current.delete(row.id)
    }
    setAttachments(prev => prev.filter(a => a.id !== row.id))
  }

  const actionsForCategory = SERVICE_ACTIONS[props.category]
  const hasActionVocab = actionsForCategory.length > 0

  function toggleAction(key: string) {
    if (isLocked) return
    if (serviceActions.includes(key)) setBillingServices(prev => prev.filter(s => !s.serviceActions?.includes(key)))
    setServiceActions(prev =>
      prev.includes(key) ? prev.filter(a => a !== key) : [...prev, key],
    )
  }

  function updateData(patch: Record<string, any>) {
    setData(prev => ({ ...prev, ...patch }))
  }

  // ----- Save (create or update) -----

  async function handleSave() {
    if (isLocked) return
    if (!servicesLoaded) { setError('Wait for service charges to load before saving QA.'); return }
    setError('')

    const hasShopItem = !!props.shopItemId
    const hasTicket = !!props.ticketId
    if (hasShopItem === hasTicket) {
      setError('Internal error: must have exactly one parent (shopItemId or ticketId)')
      return
    }

    setSaving(true)
    const recordId = props.existing?.id ?? uuidv4()
    const now = new Date().toISOString()

    const payload = {
      shopItemId: props.shopItemId ?? null,
      ticketId: props.ticketId ?? null,
      serializedEquipmentId: props.serializedEquipmentId ?? null,
      serialNumber: props.shopItemId ? serial.trim() : props.serialNumber,
      category: props.category,
      outcome,
      serviceActions,
      ...(showBilling ? { billingServices } : {}),
      data,
      partsReplaced: partsReplaced || null,
      notes: notes || null,
      ...inspectionApproval(customerApprovedName, customerApprovedSignature, props.existing, now),
      correctsId: props.correctsId ?? null,
      inspectedAt: props.existing?.inspectedAt ?? now,
    }

    // Capture-only (field wizard): don't persist — hand the in-memory record to
    // the wizard, which writes it (after the ticket) at submit.
    if (props.captureOnly) {
      const captured: OfflineEquipmentInspection = {
        id: recordId,
        shopItemId: payload.shopItemId,
        ticketId: payload.ticketId,
        serializedEquipmentId: payload.serializedEquipmentId,
        serialNumber: payload.serialNumber,
        category: payload.category,
        outcome: payload.outcome,
        serviceActions: payload.serviceActions,
        data: payload.data,
        partsReplaced: payload.partsReplaced,
        notes: payload.notes,
        inspectedById: null,
        inspectedAt: payload.inspectedAt,
        customerApprovedName: payload.customerApprovedName,
        customerApprovedSignature: payload.customerApprovedSignature,
        customerApprovedAt: payload.customerApprovedAt,
        lockedAt: null,
        correctsId: payload.correctsId,
        createdAt: props.existing?.createdAt ?? now,
        updatedAt: now,
        _offlineStatus: 'pending',
      }
      setSaving(false)
      props.onSaved?.(captured)
      props.onClose()
      return
    }

    try {
      // Try API first
      try {
        await persistShopSerial()
        const result = props.existing
          ? await api.patch<OfflineEquipmentInspection>(
              `/equipment-inspections/${recordId}`,
              payload,
            )
          : await api.post<OfflineEquipmentInspection>('/equipment-inspections', payload)

        // Mirror to Dexie so offline reads see the same row
        await db.equipmentInspections.put({
          ...result,
          id: result.id ?? recordId,
          _offlineStatus: 'synced',
        } as OfflineEquipmentInspection)

        await flushPendingAttachments(result.id ?? recordId)
        props.onSaved?.(result)
        props.onClose()
        return
      } catch (err) {
        if (props.shopItemId) throw err // QA + service charges must commit together.
        // Fall through to offline path
      }

      // Offline fallback — write to Dexie + queue mutation
      const offlineRecord: OfflineEquipmentInspection = {
        id: recordId,
        shopItemId: payload.shopItemId,
        ticketId: payload.ticketId,
        serializedEquipmentId: payload.serializedEquipmentId,
        serialNumber: payload.serialNumber,
        category: payload.category,
        outcome: payload.outcome,
        serviceActions: payload.serviceActions,
        data: payload.data,
        partsReplaced: payload.partsReplaced,
        notes: payload.notes,
        inspectedById: null,
        inspectedAt: payload.inspectedAt,
        customerApprovedName: payload.customerApprovedName,
        customerApprovedSignature: payload.customerApprovedSignature,
        customerApprovedAt: payload.customerApprovedAt,
        lockedAt: null,
        correctsId: payload.correctsId,
        createdAt: props.existing?.createdAt ?? now,
        updatedAt: now,
        _offlineStatus: 'pending',
      }

      await db.equipmentInspections.put(offlineRecord)
      await db.mutationQueue.add({
        table: 'equipmentInspections',
        action: props.existing ? 'update' : 'create',
        entityId: recordId,
        payload: { ...payload, id: recordId },
        createdAt: now,
        status: 'pending',
        retryCount: 0,
      })

      await flushPendingAttachments(recordId)
      props.onSaved?.(offlineRecord)
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save inspection')
    } finally {
      setSaving(false)
    }
  }

  // ----- Lock (one-way; UI surfaces a confirm modal first) -----

  async function handleLock() {
    if (!props.existing) return
    if (showBilling && !servicesLoaded) { setError('Wait for linked service charges to load.'); return }
    setLocking(true)
    setError('')
    const now = new Date().toISOString()

    try {
      try {
        // Lock the QA the tech is looking at, including the linked charges,
        // rather than locking the previous saved version of this form.
        await persistShopSerial()
        if (props.shopItemId) await api.patch(`/equipment-inspections/${props.existing.id}`, {
          serialNumber: serial.trim(), outcome, serviceActions, ...(showBilling ? { billingServices } : {}), data, partsReplaced: partsReplaced || null, notes: notes || null,
        })
        const locked = await api.post<OfflineEquipmentInspection>(
          `/equipment-inspections/${props.existing.id}/lock`,
          {},
        )
        await db.equipmentInspections.put({
          ...locked,
          id: locked.id ?? props.existing.id,
          _offlineStatus: 'synced',
        } as OfflineEquipmentInspection)
        props.onSaved?.(locked)
        setShowLockConfirm(false)
        props.onClose()
        return
      } catch (err) {
        if (props.shopItemId) throw err
        // A REFUSAL IS NOT A NETWORK FAILURE. This catch used to be bare, so a
        // 422 "QA checklist incomplete" from the lock route was indistinguishable
        // from being offline: the refusal was swallowed, the lock was queued as
        // an offline mutation, and the replay path routed the unit to
        // shop_complete anyway. A fully-online tech with an empty checklist could
        // release a unit and never be told the server had said no.
        //
        // So a 4xx that means "the server read this and declined on the merits"
        // (400 / 409 / 422) is shown, not queued.
        //
        // 404 is deliberately NOT one of those. An inspection created offline is
        // not on the server yet -- its own `create` is still sitting in the
        // mutation queue -- so a 404 here means "not synced yet", and the lock
        // has to queue up behind it. That is the ordinary offline flow, not an
        // error, and the sync engine already reasons about P2025 the same way.
        // Treating it as a refusal would strand the tech looking at "Record not
        // found" for a record they are holding in their hand.
        if (err instanceof ApiError && err.status !== 404 && err.status < 500) {
          // api.ts falls back to "Request failed (422)" when the body carried no
          // `error` field. A bare status code tells a tech in a shop nothing and
          // gives them nothing to do, so never let one reach the screen.
          setError(
            /^Request failed \(\d+\)$/.test(err.message)
              ? "The server wouldn't accept this lock and didn't say why. Your work is saved — " +
                'try again in a moment, and if it keeps refusing, flag it to a supervisor ' +
                'rather than working around it.'
              : err.message,
          )
          return
        }
        // Offline, or the server never gave us an answer — queue an update
        // mutation that sets lockedAt. Server's mutation processor enforces the
        // one-way semantic on replay.
      }

      const updated: OfflineEquipmentInspection = {
        ...props.existing,
        lockedAt: now,
        updatedAt: now,
        _offlineStatus: 'pending',
      }
      await db.equipmentInspections.put(updated)
      await db.mutationQueue.add({
        table: 'equipmentInspections',
        action: 'update',
        entityId: props.existing.id,
        payload: { lockedAt: now },
        createdAt: now,
        status: 'pending',
        retryCount: 0,
      })

      props.onSaved?.(updated)
      setShowLockConfirm(false)
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to lock inspection')
    } finally {
      setLocking(false)
    }
  }

  // ----- Render -----

  // Filing a correction launches a fresh editor instance — render that instead.
  if (showCorrectionEditor && props.existing) {
    return (
      <EquipmentInspectionEditor
        shopPhase={props.shopPhase}
        shopItemId={props.shopItemId}
        ticketId={props.ticketId}
        serializedEquipmentId={props.serializedEquipmentId}
        serialNumber={props.serialNumber}
        category={props.category}
        equipmentDescription={props.equipmentDescription}
        correctsId={props.existing.id}
        onSerialCorrected={props.onSerialCorrected}
        intakeConstituents={props.intakeConstituents}
        onConstituentCorrected={props.onConstituentCorrected}
        onSaved={props.onSaved}
        onClose={props.onClose}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-2xl sm:rounded-xl rounded-t-xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-slate-200 shrink-0">
          <div className="min-w-0">
            <h3 className="font-semibold text-slate-900 flex items-center gap-2">
              {isLocked && <Lock className="w-4 h-4 text-slate-500" />}
              Equipment Inspection
              {isCorrection && (
                <span className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                  Correction
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {CATEGORY_LABELS[props.category]} ·{' '}
              <span className="font-mono">{props.serialNumber}</span>
              {props.equipmentDescription && (
                <span className="ml-1 text-slate-400">— {props.equipmentDescription}</span>
              )}
            </p>
          </div>
          <button
            onClick={props.onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 shrink-0"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Locked banner */}
        {props.shopItemId && !isLocked && (
          <div className="p-4 bg-blue-50 border-b border-blue-200 space-y-2">
            <label className="block text-sm font-medium text-slate-700">Serial number (required for every outcome)
              <input value={serial} onChange={e => { setSerial(e.target.value); setSerialConfirmed(false) }} className="mt-1 block w-full px-3 py-2 border border-slate-300 rounded-lg" />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={serialConfirmed} disabled={!serial.trim()} onChange={e => setSerialConfirmed(e.target.checked)} />
              I confirmed this serial on the piece being inspected
            </label>
          </div>
        )}
        {isLocked && (
          <div className="bg-slate-50 border-b border-slate-200 px-4 py-2 flex items-center gap-2 text-xs text-slate-600 shrink-0">
            <Lock className="w-3.5 h-3.5" />
            <span>
              Locked {props.existing?.lockedAt && new Date(props.existing.lockedAt).toLocaleString()} —
              record is permanent. File a correction to amend.
            </span>
          </div>
        )}

        {/* Correction banner */}
        {isCorrection && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center gap-2 text-xs text-amber-800 shrink-0">
            <FileWarning className="w-3.5 h-3.5" />
            <span>This will be a NEW record correcting a previously locked inspection.</span>
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* QA checklist — required before "Ready for Pickup" */}
          <QaChecklistFields
            category={props.category}
            data={data}
            onChange={updateData}
            disabled={isLocked}
            waived={outcome === 'condemn' || outcome === 'cannot_service'}
            serviceActions={serviceActions}
          />

          {/* Service actions */}
          {hasActionVocab && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Service Actions Performed
                <span className="ml-2 text-xs font-normal text-slate-400">multi-select</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {actionsForCategory.map(a => {
                  const selected = serviceActions.includes(a.key)
                  return (
                    <button
                      key={a.key}
                      type="button"
                      disabled={isLocked}
                      onClick={() => toggleAction(a.key)}
                      className={cn(
                        'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
                        selected
                          ? 'bg-blue-700 text-white border-blue-700'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50',
                        isLocked && 'opacity-60 cursor-not-allowed',
                      )}
                    >
                      {a.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {showBilling && !isLocked && <ShopServicePicker category={props.category} value={billingServices} actions={serviceActions} disabled={!servicesLoaded} onChange={services => {
            const removedActions = billingServices.filter(s => !services.some(next => next.productId === s.productId)).flatMap(s => s.serviceActions ?? [])
            setBillingServices(services)
            const valid = SERVICE_ACTIONS[props.category].map(a => a.key)
            setServiceActions(prev => [...new Set([...prev.filter(a => !removedActions.includes(a)), ...services.flatMap(s => s.serviceActions ?? []).filter(a => valid.includes(a))])])
          }} />}

          {!hasActionVocab && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600">
              <p className="font-medium mb-1">Service action vocabulary not yet defined for {CATEGORY_LABELS[props.category]}.</p>
              <p className="text-slate-500">
                Capture details in the Notes field below for now. Vocabulary will land
                in a follow-up slice.
              </p>
            </div>
          )}

          {/* Outcome */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Outcome</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {OUTCOMES.map(o => {
                const selected = outcome === o.key
                const tone =
                  o.tone === 'good'
                    ? 'border-emerald-400 bg-emerald-50 text-emerald-800'
                    : o.tone === 'warn'
                      ? 'border-amber-400 bg-amber-50 text-amber-800'
                      : 'border-red-400 bg-red-50 text-red-800'
                return (
                  <button
                    key={o.key}
                    type="button"
                    disabled={isLocked}
                    onClick={() => setOutcome(o.key)}
                    className={cn(
                      'px-3 py-2 rounded-lg border-2 text-sm font-medium transition-colors',
                      selected
                        ? tone
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                      isLocked && 'opacity-60 cursor-not-allowed',
                    )}
                  >
                    {o.label}
                  </button>
                )
              })}
            </div>
            {(outcome === 'condemn' || outcome === 'cannot_service') && (
              <p className="mt-2 text-xs text-slate-500 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                On lock, this outcome will flow back to the equipment record:{' '}
                {outcome === 'condemn' ? 'Condemned' : 'Out of Service'}.
              </p>
            )}
          </div>

          {/* Attachments — condemn / cannot-service evidence + UE report PDF */}
          {showAttachments && (
            <div className="border border-slate-200 rounded-lg p-3 space-y-2">
              <label className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
                <Paperclip className="w-4 h-4 text-slate-400" />
                {isUe && outcome !== 'condemn' && outcome !== 'cannot_service'
                  ? 'UE Report & Files'
                  : 'Evidence — Photos & Files'}
              </label>
              <p className="text-xs text-slate-500">
                {isUe
                  ? 'Attach the UE report (PDF) and any supporting photos.'
                  : 'Attach photos or files documenting the condition.'}
              </p>

              {attachments.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {attachments.map(a => (
                    <div key={a.id} className="relative aspect-square bg-slate-100 rounded-lg overflow-hidden flex items-center justify-center">
                      {a.previewUrl && a.fileType === 'photo' ? (
                        <img src={a.previewUrl} alt={a.fileName} className="w-full h-full object-cover" />
                      ) : (
                        <button
                          type="button"
                          onClick={() => a.filePath && openServerFile(a.filePath)}
                          disabled={!a.filePath}
                          className="w-full h-full flex flex-col items-center justify-center text-center p-2 disabled:cursor-default"
                        >
                          {a.fileType === 'photo' ? (
                            <Camera className="w-6 h-6 text-slate-400 mb-1" />
                          ) : (
                            <FileText className="w-6 h-6 text-slate-400 mb-1" />
                          )}
                          <span className="text-[10px] text-slate-500 truncate w-full px-1">{a.fileName}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeAttachment(a)}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70"
                        aria-label="Remove attachment"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  className="hidden"
                  onChange={e => { handleAddFiles(e.target.files); e.target.value = '' }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50"
                >
                  <Camera className="w-4 h-4" /> Add Photo
                </button>
                <input
                  ref={docInputRef}
                  type="file"
                  accept={isUe ? 'application/pdf' : undefined}
                  multiple
                  className="hidden"
                  onChange={e => { handleAddFiles(e.target.files); e.target.value = '' }}
                />
                <button
                  type="button"
                  onClick={() => docInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50"
                >
                  <FileText className="w-4 h-4" /> {isUe ? 'Add Report (PDF)' : 'Add File'}
                </button>
              </div>

              {!props.existing?.id && attachments.some(a => !a.saved) && (
                <p className="text-[11px] text-amber-600">Files will be attached when you Save.</p>
              )}
            </div>
          )}

          {/* Live cascade preview — what the inspection result will DO on lock. */}
          <CascadeBanner
            category={props.category}
            data={data}
            equipmentDescription={props.equipmentDescription}
            onChange={updateData}
            disabled={isLocked}
          />

          {/* WI-07 — what intake already recorded. Shown before the form so the
              tech reads the answers rather than being asked the questions. */}
          {(props.intakeConstituents?.length ?? 0) > 0 && (
            <IntakeConstituents
              constituents={props.intakeConstituents!}
              onCorrected={props.onConstituentCorrected}
              disabled={isLocked}
            />
          )}

          {/* Category-specific sub-shape */}
          <CategoryFields
            category={props.category}
            data={data}
            onChange={updateData}
            disabled={isLocked}
          />

          {/* Parts replaced */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Parts Replaced</label>
            <input
              type="text"
              value={partsReplaced}
              onChange={e => setPartsReplaced(e.target.value)}
              disabled={isLocked}
              placeholder="e.g. valve stem, mask seal"
              className={cn(
                'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm',
                isLocked && 'bg-slate-50 cursor-not-allowed',
              )}
            />
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={isLocked}
              rows={3}
              placeholder="Free text — for unusual context only. Prefer structured fields above."
              className={cn(
                'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none',
                isLocked && 'bg-slate-50 cursor-not-allowed',
              )}
            />
          </div>

          {/* Customer approval */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Customer Approval (optional)
            </label>
            <input
              type="text"
              value={customerApprovedName}
              onChange={e => setCustomerApprovedName(e.target.value)}
              disabled={isLocked}
              placeholder="Customer name"
              className={cn(
                'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm',
                isLocked && 'bg-slate-50 cursor-not-allowed',
              )}
            />
          </div>

          {isLocked
            ? customerApprovedSignature && <img src={customerApprovedSignature} alt="Customer approval signature" className="mt-2 max-h-24 border border-slate-200 rounded" />
            : <SignaturePad value={customerApprovedSignature} onChange={setCustomerApprovedSignature} label="Customer approval signature (optional)" />}

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        {lockBlockedReason && isEditing && !props.captureOnly && (
          <div className="border-t border-slate-200 px-4 pt-3 shrink-0 flex items-start gap-2 text-xs text-amber-700">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{lockBlockedReason}</span>
          </div>
        )}
        <div className={cn(
          'p-4 shrink-0 flex items-center gap-3',
          !(lockBlockedReason && isEditing && !props.captureOnly) && 'border-t border-slate-200',
        )}>
          {!isLocked && (
            <>
              <button
                type="button"
                onClick={props.onClose}
                className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 font-medium text-sm hover:bg-slate-50"
              >
                Cancel
              </button>
              <div className="flex-1" />
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || serialBlocked}
                className="flex items-center gap-2 px-5 py-2 bg-blue-700 text-white rounded-lg font-medium text-sm hover:bg-blue-600 disabled:opacity-40"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                {isEditing ? 'Save Changes' : 'Save'}
              </button>
              {isEditing && !props.captureOnly && (
                <button
                  type="button"
                  onClick={() => setShowLockConfirm(true)}
                  disabled={!!lockBlockedReason}
                  title={lockBlockedReason ?? undefined}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-white rounded-lg font-medium text-sm hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800"
                >
                  <Lock className="w-4 h-4" />
                  Lock
                </button>
              )}
            </>
          )}
          {isLocked && (
            <>
              <button
                type="button"
                onClick={props.onClose}
                className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 font-medium text-sm hover:bg-slate-50"
              >
                Close
              </button>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setShowCorrectionEditor(true)}
                className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg font-medium text-sm hover:bg-amber-500"
              >
                <FileWarning className="w-4 h-4" />
                File Correction
              </button>
            </>
          )}
        </div>

        {/* Lock confirm modal */}
        {showLockConfirm && (
          <LockConfirmDialog
            onCancel={() => setShowLockConfirm(false)}
            onConfirm={handleLock}
            locking={locking}
          />
        )}
      </div>
    </div>
  )
}

// ============================================================
// Lock confirm dialog — emphasizes irreversibility
// ============================================================

function LockConfirmDialog(props: {
  onCancel: () => void
  onConfirm: () => void
  locking: boolean
}) {
  return (
    <div className="absolute inset-0 z-10 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
            <ShieldOff className="w-5 h-5 text-amber-700" />
          </div>
          <div className="flex-1">
            <h4 className="font-semibold text-slate-900">Lock this inspection?</h4>
            <p className="text-sm text-slate-600 mt-1">
              Locking is <span className="font-semibold">permanent</span>. After locking,
              this record can no longer be edited or deleted. Corrections must be filed as
              a NEW inspection record that references this one.
            </p>
            <p className="text-xs text-slate-500 mt-2">
              This is the audit-grade event log for the equipment — once locked, the
              history is immutable.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={props.onCancel}
            disabled={props.locking}
            className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-slate-700 font-medium text-sm hover:bg-slate-50 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={props.onConfirm}
            disabled={props.locking}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-slate-800 text-white rounded-lg font-medium text-sm hover:bg-slate-700 disabled:opacity-40"
          >
            {props.locking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
            Lock Permanently
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// Category-discriminated sub-shape fields
// ============================================================

// Derive the QA-gate boolean for a checkpoint from its recorded value. binary →
// value===true; functional/visual → value==='pass'; measured → numeric & in spec.
function deriveQaBoolean(item: Checkpoint, value: unknown): boolean {
  const kind = item.input?.kind ?? 'binary'
  if (kind === 'measured') {
    if (typeof value !== 'number' || Number.isNaN(value)) return false
    const inp = item.input as { min?: number; max?: number }
    if (typeof inp.min === 'number' && value < inp.min) return false
    if (typeof inp.max === 'number' && value > inp.max) return false
    return true
  }
  if (kind === 'functional' || kind === 'visual') return value === 'pass'
  return value === true
}

// Does the recorded value count as a "fail" for photo-on-fail purposes?
function valueIsFail(item: Checkpoint, value: unknown): boolean {
  const kind = item.input?.kind ?? 'binary'
  if (kind === 'measured') return value != null && !deriveQaBoolean(item, value)
  if (kind === 'functional' || kind === 'visual') return value === 'fail'
  return value === false
}

function QaChecklistFields(props: {
  category: EquipmentInspectionCategory
  data: Record<string, any>
  onChange: (patch: Record<string, any>) => void
  disabled: boolean
  waived: boolean
  serviceActions: string[]
}) {
  const items = getShopChecklist(props.category)
  const checks: Record<string, boolean> = useMemo(() => {
    const c = props.data.qaChecklist
    return c && typeof c === 'object' ? c : {}
  }, [props.data.qaChecklist])
  const checkpoints: Record<string, any> = useMemo(() => {
    const c = props.data.checkpoints
    return c && typeof c === 'object' ? c : {}
  }, [props.data.checkpoints])

  // Which required items actually apply given the service actions performed.
  const requiredKeys = useMemo(
    () => new Set(getRequiredShopKeys(props.category, props.serviceActions)),
    [props.category, props.serviceActions],
  )

  if (items.length === 0) return null

  // Record a checkpoint result: writes data.checkpoints[key].value (drives the
  // cascade engine) AND data.qaChecklist[key] (drives the QA gate).
  function record(item: Checkpoint, value: boolean | number | string) {
    if (props.disabled) return
    const prevCp = checkpoints[item.key] && typeof checkpoints[item.key] === 'object' ? checkpoints[item.key] : {}
    props.onChange({
      checkpoints: { ...checkpoints, [item.key]: { ...prevCp, value } },
      qaChecklist: { ...checks, [item.key]: deriveQaBoolean(item, value) },
    })
  }

  const isRequired = (item: ChecklistItem) => requiredKeys.has(item.key)
  // A normally-required item whose gating action wasn't performed (e.g. a UE
  // test check on a Visual Only inspection) — shown, but not required/counted.
  const isWaivedItem = (item: ChecklistItem) =>
    item.requiredInShop && !itemApplies(item, props.serviceActions)

  const missingRequired = items.filter(i => isRequired(i) && checks[i.key] !== true)
  const allRequiredDone = missingRequired.length === 0
  const anyWaived = items.some(isWaivedItem)

  return (
    <div className="border-2 border-slate-300 rounded-lg overflow-hidden">
      <div className="bg-slate-800 px-3 py-2 flex items-center justify-between">
        <p className="text-xs font-bold text-white uppercase tracking-wide flex items-center gap-1.5">
          <ClipboardCheck className="w-3.5 h-3.5" />
          QA Checklist — Service Sign-off
        </p>
        {props.waived ? (
          <span className="text-[10px] font-medium text-amber-200">Waived (condemn / cannot service)</span>
        ) : allRequiredDone ? (
          <span className="text-[10px] font-medium text-emerald-300 flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5" /> Complete
          </span>
        ) : (
          <span className="text-[10px] font-medium text-amber-200">
            {missingRequired.length} required item{missingRequired.length === 1 ? '' : 's'} left
          </span>
        )}
      </div>
      <div className="p-3 space-y-1.5 bg-white">
        {!props.waived && anyWaived && (
          <p className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded px-2 py-1 flex items-start gap-1.5">
            <ClipboardCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Items marked “N/A” aren’t required — the matching service action wasn’t performed.
          </p>
        )}
        {!props.waived && !allRequiredDone && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            All required (★) items must be answered before this item can move to “Ready for Pickup”.
          </p>
        )}
        {items.map(item => (
          <CheckpointRow
            key={item.key}
            item={item as Checkpoint}
            value={checkpoints[item.key]?.value}
            qaSatisfied={checks[item.key] === true}
            required={isRequired(item)}
            waivedItem={isWaivedItem(item)}
            gateWaived={props.waived}
            disabled={props.disabled}
            onRecord={(v) => record(item as Checkpoint, v)}
          />
        ))}
      </div>
    </div>
  )
}

// A single checkpoint row, rendered per its input kind.
function CheckpointRow(props: {
  item: Checkpoint
  value: unknown
  qaSatisfied: boolean
  required: boolean
  waivedItem: boolean
  gateWaived: boolean
  disabled: boolean
  onRecord: (v: boolean | number | string) => void
}) {
  const { item } = props
  const kind = item.input?.kind ?? 'binary'
  const isMissing = props.required && !props.qaSatisfied && !props.gateWaived
  const needsPhoto =
    item.photo === 'always' || (item.photo === 'on_fail' && valueIsFail(item, props.value))

  const label = (
    <span className="text-slate-700 leading-snug">
      {props.required && <span className="text-red-600 font-bold mr-1">★</span>}
      {item.label}
      {props.waivedItem && (
        <span className="ml-1.5 text-[10px] font-medium text-slate-400 uppercase tracking-wide">
          N/A — not performed
        </span>
      )}
    </span>
  )

  return (
    <div
      className={cn(
        'rounded px-2 py-1.5 text-sm',
        isMissing ? 'bg-amber-50' : '',
        (props.disabled || props.waivedItem) && 'opacity-60',
      )}
    >
      {kind === 'binary' && (
        <label className={cn('flex items-start gap-2.5', !props.disabled && 'cursor-pointer')}>
          <input
            type="checkbox"
            checked={props.value === true}
            onChange={() => props.onRecord(props.value === true ? false : true)}
            disabled={props.disabled}
            className="w-4 h-4 mt-0.5 rounded border-slate-300 text-blue-700 shrink-0"
          />
          {label}
        </label>
      )}

      {(kind === 'functional' || kind === 'visual') && (
        <div className="flex items-start gap-2.5">
          <div className="flex gap-1 shrink-0">
            {(['pass', 'fail'] as const).map((v) => (
              <button
                key={v}
                type="button"
                disabled={props.disabled}
                onClick={() => props.onRecord(v)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors',
                  props.value === v
                    ? v === 'pass'
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-red-600 text-white border-red-600'
                    : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50',
                  props.disabled && 'cursor-not-allowed',
                )}
              >
                {v === 'pass' ? 'Pass' : 'Fail'}
              </button>
            ))}
          </div>
          {label}
        </div>
      )}

      {kind === 'measured' && (
        <div className="flex items-start justify-between gap-2">
          {label}
          <div className="flex items-center gap-1.5 shrink-0">
            <input
              type="number"
              value={typeof props.value === 'number' ? props.value : ''}
              onChange={(e) => props.onRecord(e.target.value === '' ? NaN : Number(e.target.value))}
              disabled={props.disabled}
              className="w-20 px-2 py-1 border border-slate-300 rounded-md text-sm"
            />
            <span className="text-[10px] text-slate-400">
              {(item.input as { unit?: string; spec?: string })?.unit}
              {(item.input as { spec?: string })?.spec ? ` (${(item.input as { spec?: string }).spec})` : ''}
            </span>
          </div>
        </div>
      )}

      {needsPhoto && (
        <p className="mt-1 ml-6 text-[10px] font-medium text-amber-700 flex items-center gap-1">
          <Camera className="w-3 h-3" /> Photo required for this result (capture in a later slice)
        </p>
      )}
    </div>
  )
}

// Live preview of what the recorded results will DO on lock — the cascade engine
// runs the same rules the server uses to route the unit. Surfaces CONDEMN /
// FACTORY_RETURN / FORCE_PARTS, and captures the ack for REQUIRE_ACK rules.
function CascadeBanner(props: {
  category: EquipmentInspectionCategory
  data: Record<string, any>
  equipmentDescription?: string
  onChange: (patch: Record<string, any>) => void
  disabled: boolean
}) {
  const checkpoints: Record<string, any> =
    props.data.checkpoints && typeof props.data.checkpoints === 'object' ? props.data.checkpoints : {}
  const results = extractCheckpointResults({ checkpoints })
  const actions: CascadeAction[] = evaluateCascades(props.category, results, { model: props.equipmentDescription ?? '' })

  if (actions.length === 0) return null

  const tone: Record<string, { cls: string; icon: typeof Skull; label: string }> = {
    CONDEMN: { cls: 'border-red-300 bg-red-50 text-red-800', icon: Skull, label: 'Will CONDEMN this unit' },
    FACTORY_RETURN: { cls: 'border-purple-300 bg-purple-50 text-purple-800', icon: Truck, label: 'Routes to outside vendor (factory return)' },
    FORCE_PARTS: { cls: 'border-amber-300 bg-amber-50 text-amber-800', icon: Wrench, label: 'Forces parts onto the repair' },
    REQUIRE_ACK: { cls: 'border-blue-300 bg-blue-50 text-blue-800', icon: AlertTriangle, label: 'Requires acknowledgment' },
  }

  function ack(checkpointKey: string) {
    if (props.disabled) return
    const prev = checkpoints[checkpointKey] && typeof checkpoints[checkpointKey] === 'object' ? checkpoints[checkpointKey] : {}
    props.onChange({ checkpoints: { ...checkpoints, [checkpointKey]: { ...prev, ack: true } } })
  }

  return (
    <div className="space-y-2">
      {actions.map((a) => {
        const t = tone[a.action] ?? tone.REQUIRE_ACK
        const Icon = t.icon
        const acked = checkpoints[a.checkpointKey]?.ack === true
        return (
          <div key={a.ruleId} className={cn('rounded-lg border-2 px-3 py-2 text-sm flex items-start gap-2', t.cls)}>
            <Icon className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold">{t.label}</p>
              {a.action === 'FORCE_PARTS' && a.parts && a.parts.length > 0 && (
                <p className="text-xs mt-0.5">Parts: {a.parts.join(', ')}</p>
              )}
              {a.ackText && <p className="text-xs mt-0.5 italic">“{a.ackText}”</p>}
              {a.action === 'REQUIRE_ACK' && (
                <label className="mt-1 flex items-center gap-1.5 text-xs font-medium cursor-pointer">
                  <input type="checkbox" checked={acked} onChange={() => ack(a.checkpointKey)} disabled={props.disabled} className="w-3.5 h-3.5" />
                  I acknowledge this instruction
                </label>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * WI-07 — the parts recorded at intake, shown at inspection.
 *
 * The complaint this answers: SCBA intake writes down the pack and its
 * constituent serials, none of it reaches the ticket, and the initial
 * inspection asks for all of it again. So it is displayed here, read-first.
 *
 * Editable, because the realistic failure is a serial typed into the wrong
 * field at the counter, and the fix must not be "redo intake" — intake is a
 * historical record of the unit arriving, not a scratch pad. Correcting one
 * writes to the CHILD UNIT record (audited server-side), not to this
 * inspection: the serial is that unit's identity everywhere it appears, so
 * fixing it in a form field here would leave the wrong value on the shelf label
 * and in VaultPRO.
 *
 * Click-to-edit rather than a row of open boxes: these are almost always right,
 * and a form full of editable serials invites accidental edits to identity.
 */
function IntakeConstituents(props: {
  constituents: Array<{ id: string; label: string; serialNumber: string; notIncluded?: boolean }>
  onCorrected?: (childItemId: string, serialNumber: string) => Promise<void>
  disabled: boolean
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  async function commit(id: string) {
    const next = draft.trim()
    const current = props.constituents.find(c => c.id === id)?.serialNumber ?? ''
    if (!next || next === current) { setEditingId(null); return }
    setSaving(true)
    try {
      await props.onCorrected?.(id, next)
      setEditingId(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
      <p className="text-xs font-semibold text-slate-600 mb-2">
        From intake
        <span className="font-normal text-slate-400"> — recorded when the unit came in</span>
      </p>
      <ul className="space-y-1">
        {props.constituents.map(c => (
          <li key={c.id} className="flex items-center gap-2 text-sm">
            <span className="text-slate-500 w-24 shrink-0">{c.label}</span>
            {c.notIncluded ? (
              // Never arrived: no unit record exists, so there is nothing to correct.
              <span className="text-amber-700 flex-1">Not included</span>
            ) : editingId === c.id ? (
              <>
                <input
                  autoFocus
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void commit(c.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="flex-1 px-2 py-1 border border-blue-300 rounded font-mono text-sm"
                />
                <button
                  type="button" disabled={saving} onClick={() => void commit(c.id)}
                  className="text-xs font-semibold text-blue-700 disabled:opacity-40"
                >
                  {saving ? '…' : 'Save'}
                </button>
                <button
                  type="button" onClick={() => setEditingId(null)}
                  className="text-xs text-slate-500"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="font-mono text-slate-800 flex-1 truncate">{c.serialNumber}</span>
                {!props.disabled && props.onCorrected && (
                  <button
                    type="button"
                    onClick={() => { setDraft(c.serialNumber); setEditingId(c.id) }}
                    className="p-1 text-slate-400 hover:text-blue-600"
                    title="Correct this serial"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function CategoryFields(props: {
  category: EquipmentInspectionCategory
  data: Record<string, any>
  onChange: (patch: Record<string, any>) => void
  disabled: boolean
}) {
  switch (props.category) {
    case 'fire_extinguisher':
      return <FexFields {...props} />
    case 'gas_detection':
      return <GasFields {...props} />
    case 'scba':
      return <ScbaFields {...props} />
    case 'ue_cylinder':
      return <UeCylinderFields {...props} />
    case 'first_aid_kit':
      return <FirstAidFields {...props} />
    case 'fall_arrest':
      return <FallArrestFields {...props} />
    case 'breathing_air_system':
      return <StubFields label="Breathing Air System" hint="Sub-shape TBD — capture details in Notes for now." />
    case 'other':
      return <OtherFields {...props} />
    default:
      return null
  }
}

function StubFields(props: { label: string; hint: string }) {
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600">
      <p className="font-medium text-slate-700">{props.label}</p>
      <p className="text-slate-500 mt-1">{props.hint}</p>
    </div>
  )
}

function FieldGrid(props: { children: React.ReactNode; cols?: number }) {
  const cols = props.cols ?? 2
  return (
    <div className={cn('grid gap-3', cols === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
      {props.children}
    </div>
  )
}

function TextField(props: {
  label: string
  value: any
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{props.label}</label>
      <input
        type="text"
        value={props.value ?? ''}
        onChange={e => props.onChange(e.target.value)}
        disabled={props.disabled}
        placeholder={props.placeholder}
        className={cn(
          'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm',
          props.disabled && 'bg-slate-50 cursor-not-allowed',
        )}
      />
    </div>
  )
}

function DateField(props: {
  label: string
  value: any
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{props.label}</label>
      <input
        type="date"
        value={props.value ?? ''}
        onChange={e => props.onChange(e.target.value)}
        disabled={props.disabled}
        className={cn(
          'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm',
          props.disabled && 'bg-slate-50 cursor-not-allowed',
        )}
      />
    </div>
  )
}

// ----- FEX -----

function FexFields(props: { data: Record<string, any>; onChange: (p: Record<string, any>) => void; disabled: boolean }) {
  return (
    <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 space-y-3">
      <p className="text-xs font-semibold text-orange-800 uppercase tracking-wide">FEX Details</p>
      <FieldGrid cols={3}>
        <TextField label="Brand" value={props.data.brand} onChange={v => props.onChange({ brand: v })} placeholder="Amerex" disabled={props.disabled} />
        <TextField label="Type" value={props.data.type} onChange={v => props.onChange({ type: v })} placeholder="ABC" disabled={props.disabled} />
        <TextField label="Size" value={props.data.size} onChange={v => props.onChange({ size: v })} placeholder="5#" disabled={props.disabled} />
      </FieldGrid>
      <TextField label="Location on site" value={props.data.location} onChange={v => props.onChange({ location: v })} placeholder="e.g. Compressor building, north wall" disabled={props.disabled} />
    </div>
  )
}

// ----- Gas Detection -----

function GasFields(props: { data: Record<string, any>; onChange: (p: Record<string, any>) => void; disabled: boolean }) {
  const sensors: string[] = Array.isArray(props.data.sensors) ? props.data.sensors : []
  const sensorOptions = ['LEL', 'O2', 'H2S', 'CO', 'SO2', 'PID/VOC']

  function toggleSensor(s: string) {
    if (props.disabled) return
    props.onChange({
      sensors: sensors.includes(s) ? sensors.filter(x => x !== s) : [...sensors, s],
    })
  }

  return (
    <div className="bg-teal-50 border border-teal-200 rounded-lg p-3 space-y-3">
      <p className="text-xs font-semibold text-teal-800 uppercase tracking-wide">Gas Monitor Details</p>
      <FieldGrid>
        <TextField label="Make" value={props.data.make} onChange={v => props.onChange({ make: v })} placeholder="Honeywell BW" disabled={props.disabled} />
        <TextField label="Model" value={props.data.model} onChange={v => props.onChange({ model: v })} placeholder="MicroClip XL" disabled={props.disabled} />
      </FieldGrid>
      <FieldGrid>
        <DateField label="Last Calibration" value={props.data.lastCalibration} onChange={v => props.onChange({ lastCalibration: v })} disabled={props.disabled} />
        <TextField label="Sensor Replaced" value={props.data.sensorReplaced} onChange={v => props.onChange({ sensorReplaced: v })} placeholder="Only if applicable" disabled={props.disabled} />
      </FieldGrid>
      {props.data.binLocation && (
        <TextField label="Shop Bin" value={props.data.binLocation} onChange={v => props.onChange({ binLocation: v })} disabled={props.disabled} />
      )}
      <div>
        <label className="block text-xs font-medium text-teal-700 mb-1.5">Sensors</label>
        <div className="flex flex-wrap gap-1.5">
          {sensorOptions.map(s => (
            <button
              key={s}
              type="button"
              disabled={props.disabled}
              onClick={() => toggleSensor(s)}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
                sensors.includes(s)
                  ? 'bg-teal-600 text-white border-teal-600'
                  : 'bg-white text-teal-700 border-teal-300 hover:bg-teal-100',
                props.disabled && 'opacity-60 cursor-not-allowed',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ----- SCBA -----

function ScbaFields(props: { data: Record<string, any>; onChange: (p: Record<string, any>) => void; disabled: boolean }) {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-3">
      <p className="text-xs font-semibold text-blue-800 uppercase tracking-wide">SCBA Details</p>
      <FieldGrid>
        <DateField label="Hydro Date" value={props.data.hydroDate} onChange={v => props.onChange({ hydroDate: v })} disabled={props.disabled} />
        <DateField label="Posi-Check Date" value={props.data.posiCheckDate} onChange={v => props.onChange({ posiCheckDate: v })} disabled={props.disabled} />
      </FieldGrid>
      <FieldGrid>
        <TextField label="Mask Size" value={props.data.maskSize} onChange={v => props.onChange({ maskSize: v })} placeholder="S / M / L" disabled={props.disabled} />
        <TextField label="Mask Condition" value={props.data.maskCondition} onChange={v => props.onChange({ maskCondition: v })} placeholder="Pass / Worn / Replaced" disabled={props.disabled} />
      </FieldGrid>
      <FieldGrid>
        <TextField label="Regulator Serial" value={props.data.regulatorSerial} onChange={v => props.onChange({ regulatorSerial: v })} disabled={props.disabled} />
        <TextField label="Block / Reducer Serial" value={props.data.blockReducerSerial} onChange={v => props.onChange({ blockReducerSerial: v })} disabled={props.disabled} />
      </FieldGrid>
    </div>
  )
}

// ----- Fall Arrest -----

function FallArrestFields(props: { data: Record<string, any>; onChange: (p: Record<string, any>) => void; disabled: boolean }) {
  return (
    <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 space-y-3">
      <p className="text-xs font-semibold text-purple-800 uppercase tracking-wide">Fall Arrest Details</p>
      <FieldGrid>
        <TextField label="Brand" value={props.data.brand} onChange={v => props.onChange({ brand: v })} disabled={props.disabled} />
        <TextField label="Model" value={props.data.model} onChange={v => props.onChange({ model: v })} disabled={props.disabled} />
      </FieldGrid>
    </div>
  )
}

// ----- Other -----

function OtherFields(props: { data: Record<string, any>; onChange: (p: Record<string, any>) => void; disabled: boolean }) {
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-3">
      <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Equipment Details</p>
      <TextField label="Description" value={props.data.description} onChange={v => props.onChange({ description: v })} disabled={props.disabled} />
    </div>
  )
}

// ----- UE Cylinder (light schema; expand later) -----

function UeCylinderFields(props: { data: Record<string, any>; onChange: (p: Record<string, any>) => void; disabled: boolean }) {
  return (
    <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 space-y-3">
      <p className="text-xs font-semibold text-purple-800 uppercase tracking-wide">UE Cylinder Details</p>
      <FieldGrid>
        <DateField label="Hydro Date" value={props.data.hydroDate} onChange={v => props.onChange({ hydroDate: v })} disabled={props.disabled} />
        <TextField label="UE Result" value={props.data.ueResult} onChange={v => props.onChange({ ueResult: v })} placeholder="Pass / Fail / Anomaly" disabled={props.disabled} />
      </FieldGrid>
      <TextField label="Wall Thickness Readings (free-text for now)" value={props.data.wallThicknessReadings} onChange={v => props.onChange({ wallThicknessReadings: v })} placeholder="e.g. 0.182, 0.181, 0.180 — 12 stations" disabled={props.disabled} />
    </div>
  )
}

// ----- First Aid Kit (simple checklist) -----

function FirstAidFields(props: { data: Record<string, any>; onChange: (p: Record<string, any>) => void; disabled: boolean }) {
  const checked = useMemo(() => {
    const c = props.data.checklist
    return c && typeof c === 'object' ? c : {}
  }, [props.data.checklist])

  const items = ['Bandages', 'Antiseptic', 'Burn Gel', 'Eye Wash', 'Gloves', 'Tourniquet']

  function toggle(item: string) {
    if (props.disabled) return
    props.onChange({ checklist: { ...checked, [item]: !checked[item] } })
  }

  return (
    <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 space-y-2">
      <p className="text-xs font-semibold text-rose-800 uppercase tracking-wide">First Aid Kit Contents</p>
      <div className="grid grid-cols-2 gap-2">
        {items.map(item => (
          <label key={item} className={cn('flex items-center gap-2 text-sm', props.disabled && 'opacity-60')}>
            <input
              type="checkbox"
              checked={!!checked[item]}
              onChange={() => toggle(item)}
              disabled={props.disabled}
              className="w-4 h-4 rounded border-slate-300 text-rose-600"
            />
            {item}
          </label>
        ))}
      </div>
    </div>
  )
}
