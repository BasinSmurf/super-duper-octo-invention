// #19/#20 Deploy QA gate — per-category inspection checklists popped when a
// tech adds a piece of gear to a rental job. Config-driven: edit the lists
// here, no form-code changes needed.
//
// Failure behavior (per user 2026-06-10): "allow with required notes" — a
// flagged answer (Needs Repair / Inoperable / No) never blocks the deploy,
// but the tech must write a note explaining before the unit can be added.

export type DeployCategory = 'trailer' | 'gas_detection' | 'general'

export interface DeployQuestion {
  key: string
  label: string
  /** tri = Proper Condition / Needs Repair / Inoperable; yn = Yes / No */
  kind: 'tri' | 'yn'
}

export interface DeploySection {
  key: string
  title: string
  questions: DeployQuestion[]
}

export interface DeployChecklist {
  category: DeployCategory
  title: string
  sections: DeploySection[]
  /** Multi-select configuration chips (gas detection: how is it configured?) */
  configOptions?: { key: string; label: string }[]
}

export const TRI_ANSWERS = [
  { value: 'pass' as const, label: 'Proper Condition', flagged: false },
  { value: 'needs_repair' as const, label: 'Needs Repair', flagged: true },
  { value: 'inoperable' as const, label: 'Inoperable', flagged: true },
]

const TRAILER_CHECKLIST: DeployChecklist = {
  category: 'trailer',
  title: 'Trailer Inspection',
  sections: [
    {
      key: 'trailer_inspection',
      title: 'Trailer Inspection Information',
      questions: [
        { key: 'brake_lights', label: 'Brake Lights', kind: 'tri' },
        { key: 'exterior_body', label: 'Exterior (Body)', kind: 'tri' },
        { key: 'wheels', label: 'Wheels', kind: 'tri' },
        { key: 'wiring_harness', label: 'Trailer Wiring & Harness', kind: 'tri' },
        { key: 'hitch_mechanism', label: 'Trailer Hitch Mechanism', kind: 'tri' },
        { key: 'chains_hooks', label: 'Trailer Chains / Hooks', kind: 'tri' },
        { key: 'jack_system', label: 'Trailer Jack System', kind: 'tri' },
        { key: 'brake_system', label: 'Trailer Brake System', kind: 'tri' },
      ],
    },
    {
      key: 'air_trailer_quick_check',
      title: 'Air Trailer Quick Check',
      questions: [
        { key: 'cylinders_upright', label: 'All Cylinders Upright / Secured', kind: 'yn' },
        { key: 'cylinders_full', label: 'Cylinders Full / Ready for Use', kind: 'yn' },
        { key: 'cargo_hoses_secured', label: 'Cargo / Hoses Secured', kind: 'yn' },
        { key: 'packs_5min', label: '5 Minute Packs on Board', kind: 'yn' },
        { key: 'packs_30min', label: '30 Minute Packs on Board', kind: 'yn' },
        { key: 'fire_extinguishers', label: 'Fire Extinguishers on Board', kind: 'yn' },
        { key: 'entrance_sign', label: 'Location Entrance Sign on Board', kind: 'yn' },
        { key: 'windsock', label: 'Windsock on Board', kind: 'yn' },
      ],
    },
    {
      key: 'trailer_status',
      title: 'Status',
      questions: [
        { key: 'posi_hydro_current', label: 'Are Posi / Hydro Current?', kind: 'yn' },
        { key: 'all_equipment_operational', label: 'Is All Equipment Operational?', kind: 'yn' },
      ],
    },
  ],
}

const GAS_DETECTION_CHECKLIST: DeployChecklist = {
  category: 'gas_detection',
  title: 'Gas Detection Check',
  sections: [
    {
      key: 'gas_check',
      title: 'Gas Detection',
      questions: [
        { key: 'calibrated', label: 'Is it calibrated?', kind: 'yn' },
        { key: 'clean', label: 'Is it clean?', kind: 'yn' },
      ],
    },
  ],
  configOptions: [
    { key: 'single_gas', label: 'Single Gas' },
    { key: 'multi_gas', label: 'Multi-Gas' },
    { key: 'lel', label: 'LEL' },
  ],
}

const GENERAL_CHECKLIST: DeployChecklist = {
  category: 'general',
  title: 'Equipment Check',
  sections: [
    {
      key: 'general_check',
      title: 'Quick Check',
      questions: [
        { key: 'clean', label: 'Is it clean?', kind: 'yn' },
        { key: 'good_working_order', label: 'In good working order?', kind: 'yn' },
      ],
    },
  ],
}

const CHECKLISTS: Record<DeployCategory, DeployChecklist> = {
  trailer: TRAILER_CHECKLIST,
  gas_detection: GAS_DETECTION_CHECKLIST,
  general: GENERAL_CHECKLIST,
}

export function getDeployChecklist(category: DeployCategory): DeployChecklist {
  return CHECKLISTS[category]
}

/** Resolve which checklist a product gets. Product categories carry no
 * 'trailer' value (trailers are assemblies), so the name decides there. */
export function resolveDeployCategory(product: { category?: string | null; name?: string | null }): DeployCategory {
  const cat = (product.category || '').toLowerCase()
  const name = (product.name || '').toLowerCase()
  if (name.includes('trailer')) return 'trailer'
  if (cat === 'monitor_personal' || cat === 'monitor_area' || cat === 'sensor') return 'gas_detection'
  if (name.includes('monitor') || name.includes('gas detect')) return 'gas_detection'
  return 'general'
}

/** Stored on the rental item (rental_agreement_items.deploy_inspection). */
export interface DeployInspectionResult {
  /** Visit metadata retained when stock equipment is swapped or returned. */
  testDate?: string
  lastSwapDate?: string
  returnInspectionId?: string
  /** Actual deployment instant; inspection and recording may happen later. */
  deployedAt?: string
  category: DeployCategory
  /** question key → 'pass' | 'needs_repair' | 'inoperable' (tri) or 'yes' | 'no' (yn) */
  answers: Record<string, string>
  /** gas detection configuration chips, e.g. ['multi_gas','lel'] */
  gasConfig?: string[]
  /** any flagged answers (needs_repair / inoperable / no) */
  flagged: boolean
  /** required when flagged */
  notes: string
  inspectedAt: string
  inspectedBy?: string | null
  /** assembly children: inspected as part of this parent item id */
  coveredBy?: string
}

export function isFlaggedAnswer(value: string): boolean {
  return value === 'needs_repair' || value === 'inoperable' || value === 'no'
}
