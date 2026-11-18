import { v5 as uuidv5 } from 'uuid'
import type { OfflineEquipmentInspection } from './db-types'
import type { LineItem } from '@/components/LineItemEditor'

export function fieldInspectionBillingError(records: OfflineEquipmentInspection[]): string | null {
  if (!records.length) return 'Add at least one inspection.'
  for (const record of records.filter(r => r.outcome === 'pass')) {
    const services = record.fieldBillingServices ?? []
    if (!services.length) return `Choose a billable inspection service for ${record.serialNumber}.`
    if (services.some(s => !s.productId || !Number.isFinite(s.quantity) || s.quantity <= 0 || !Number.isFinite(s.rate) || s.rate < 0))
      return `Enter a valid quantity and rate for ${record.serialNumber}.`
    if (new Set(services.map(s => s.productId)).size !== services.length)
      return `Remove duplicate services for ${record.serialNumber}.`
  }
  return null
}

/** Reconcile just the inspection charges; unrelated labor/parts remain intact. */
export function fieldInspectionBillingLines(lines: LineItem[], records: OfflineEquipmentInspection[]): LineItem[] {
  const charges = records.filter(r => r.outcome === 'pass').flatMap(record => (record.fieldBillingServices ?? []).map(service => ({
    id: uuidv5(`servicepro:field-charge:${record.id}:${service.productId}`, uuidv5.URL),
    fieldInspectionId: record.id,
    lineType: 'inspection', productId: service.productId, partNumber: service.partNumber,
    description: `${service.name} — ${record.serialNumber}`, quantity: service.quantity,
    rate: service.rate, total: Math.round(service.quantity * service.rate * 100) / 100,
    unitOfMeasure: service.unitOfMeasure || 'EA', testResult: 'pass' as const,
    notes: `Field inspection ${record.id}; serial ${record.serialNumber}`,
  })))
  const ids = new Set(charges.map(line => line.id))
  return [...lines.filter(line => !line.fieldInspectionId && !ids.has(line.id)), ...charges]
}
