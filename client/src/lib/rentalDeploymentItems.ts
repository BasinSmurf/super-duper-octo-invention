import type { OfflineRentalAgreementItem, RentalComposition } from './db-types'

/**
 * One blank equipment row per unit the rental ordered, for the tech to fill in
 * at deploy. Package rows carry the package line's own category: that is the
 * axis the package check counts on, and the bound product's catalog category
 * can disagree with it (an area-monitor rental item catalogued as a personal
 * monitor), which turned a complete deploy into "short" plus unpriced extras.
 */
export function seedDeploymentRows(
  rental: { id: string; billingRateType: string; composition?: RentalComposition | null },
  newId: () => string,
): OfflineRentalAgreementItem[] {
  const c = rental.composition
  const specs: { label: string; qty: number; productId: string; equipmentCategory?: string }[] = [
    ...(c?.trailer ? [{ label: 'Trailer', qty: 1, productId: '' }] : []),
    ...(c?.gasMonitors || []).map(g => ({ label: g.productName || 'Gas monitor', qty: g.qty, productId: g.productId })),
    ...(c?.other || []).map(o => ({ label: o.label, qty: o.qty, productId: o.productId || '' })),
    ...(c?.bom || []).map(b => ({ label: b.label, qty: b.qty, productId: b.productId || '', equipmentCategory: b.equipmentCategory })),
  ]
  return specs.flatMap(spec => Array.from({ length: spec.qty || 1 }, () => ({
    id: newId(), rentalAgreementId: rental.id, productId: spec.productId, productName: spec.label,
    ...(spec.equipmentCategory ? { equipmentCategory: spec.equipmentCategory } : {}),
    serializedEquipmentId: '', serialNumber: '', testDate: '', manualEntry: true, rate: 0,
    rateType: rental.billingRateType, deployedDate: '', returnedDate: null, status: 'deployed',
  })))
}

/** The category a deployed row counts against: its package line's, else its product's. */
export function deploymentRowCategory(
  row: Pick<OfflineRentalAgreementItem, 'equipmentCategory' | 'productId'>,
  productCategory: (productId?: string | null) => string | null,
): string | null {
  return row.equipmentCategory || productCategory(row.productId)
}

/** Format common date entries while allowing the technician's free-text notes. */
export function formatEquipmentTestDate(value: string): string {
  const text = value.trim()
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (iso) return `${iso[2].padStart(2, '0')}/${iso[3].padStart(2, '0')}/${iso[1]}`
  const us = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(text)
  if (us) return `${us[1].padStart(2, '0')}/${us[2].padStart(2, '0')}/${us[3]}`
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 2)}/${text.slice(2, 4)}/${text.slice(4)}`
  return value
}

/** Components remain rental records for inventory/returns, under their assembly. */
export function rentalDeploymentLines(items: OfflineRentalAgreementItem[]): OfflineRentalAgreementItem[] {
  const itemIds = new Set(items.map(item => item.id))
  return items.filter(item => !item.deployInspection?.coveredBy || !itemIds.has(item.deployInspection.coveredBy))
}

/** Removing an assembly also removes the components being deployed with it. */
export function removeRentalDeployment(items: OfflineRentalAgreementItem[], itemId: string): OfflineRentalAgreementItem[] {
  const removed = new Set([itemId])
  let changed = true
  while (changed) {
    changed = false
    for (const item of items) {
      if (item.deployInspection?.coveredBy && removed.has(item.deployInspection.coveredBy) && !removed.has(item.id)) {
        removed.add(item.id)
        changed = true
      }
    }
  }
  return items.filter(item => !removed.has(item.id))
}
