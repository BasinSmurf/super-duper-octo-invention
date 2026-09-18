// ============================================================================
// AUTO-GENERATED — DO NOT EDIT.
// Mirror of server/src/services/inspectionChecklist.ts (the single source of
// truth for the QA-checklist catalog + gate logic). Regenerate after editing
// the server file:   npm run gen:checklist   (from the repo root)
// ============================================================================

// QA checklist catalog — per equipment-inspection category.
//
// Source-of-truth for the shop pre-pickup QA gate. An item cannot move to
// `shop_complete` (which flips the work order to "Ready for Pickup") until a
// QA-complete EquipmentInspection exists for it. "QA-complete" = every
// `requiredInShop` item for the category is checked true in data.qaChecklist.
//
// Content derived from Basin Safety's ServicePro inspection criteria. Each item
// carries a `scope`: items that only make sense in the FIELD (mounting height,
// line-of-sight, anchorage rating, rescue plan, etc.) are kept here flagged
// `field` so a future field-inspection workflow can reuse this catalog — they
// are NOT shown or required in the shop.
//
// THIS FILE IS THE SINGLE SOURCE OF TRUTH for the catalog + gate logic. The
// client copy at client/src/lib/inspectionChecklist.ts is GENERATED from this
// file — do not edit it by hand. After changing this file, regenerate with:
//     npm run gen:checklist   (from the repo root)
// The file is pure (no imports), so the generated client copy compiles as-is.

export type InspectionCategory =
  | 'fire_extinguisher'
  | 'gas_detection'
  | 'scba'
  | 'fall_arrest'
  | 'ue_cylinder'
  | 'breathing_air_system'
  | 'first_aid_kit'
  | 'other';

// Shop equipment categories (Prisma EquipmentCategoryShop) → inspection category.
export type ShopEquipmentCategory =
  | 'fire_extinguisher'
  | 'area_monitor'
  | 'personal_monitor'
  | 'fall_arrest'
  | 'scba'
  | 'ue_cylinder'
  | 'other';

export type ChecklistScope = 'shop' | 'field';

// ── Structured checkpoint layer (ShopWork refactor, Wave 1) ──────────────────
// A Checkpoint is the richer shape the inspection captures. Every field beyond
// the original flat-checklist set is OPTIONAL, so the existing catalog entries
// (key/label/scope/requiredInShop[/appliesToActions]) remain valid Checkpoints
// with no change, and the shop QA gate keeps working untouched. New entries can
// declare a measured/functional/visual input, a photo policy, a manual
// reference (audit-snapshot spine + future reference pane), and cascade rules.

/** How the tech records the result for a checkpoint. Omit ⇒ binary. */
export type CheckpointInput =
  | { kind: 'binary' }
  | { kind: 'measured'; unit: string; min?: number; max?: number; spec?: string }
  | { kind: 'functional' }
  | { kind: 'visual' };

/** When a photo must accompany the checkpoint result. Omit ⇒ never. */
export type PhotoPolicy = 'never' | 'on_fail' | 'always';

/** Pointer into the source manual — quoted verbatim in the pane, snapshotted at lock. */
export interface ManualRef {
  doc: string;
  section?: string;
  revision?: string;
}

export interface Checkpoint {
  key: string;
  label: string;
  /** Where this check applies. Shop gate only considers items including 'shop'. */
  scope: ChecklistScope[];
  /** If true and scope includes 'shop', must be checked before shop_complete. */
  requiredInShop: boolean;
  /**
   * If set, this item is only required when the inspection performed at least
   * one of these service actions (keys from SERVICE_ACTION_VOCAB). Omit ⇒ the
   * item always applies. This is how QA requirements flex with the work done:
   *   - A "UE test performed" check applies only to ['ue_test','hydro'].
   *   - A Visual Only inspection performs none of those, so the check drops.
   *   - Selecting Visual Only AND UE Test brings it back.
   * Add a rule by tagging the item — no engine code changes.
   */
  appliesToActions?: string[];
  /**
   * Sub-types this checkpoint applies to (e.g. Fall Arrest ['harness','srl']).
   * Omit ⇒ applies to all sub-types of the category. Shared-core checkpoints
   * omit this; sub-type-specific guts declare it.
   */
  subTypes?: string[];
  /** How the result is captured. Omit ⇒ binary (the historical default). */
  input?: CheckpointInput;
  /** Photo capture policy. Omit ⇒ never. */
  photo?: PhotoPolicy;
  /** Manual reference — drives the reference pane and the audit snapshot at lock. */
  manualRef?: ManualRef;
  /** Ids of CascadeRule entries (in CASCADE_RULES) keyed off this checkpoint's result. */
  cascade?: string[];
}

/**
 * Back-compat alias. The catalog historically held `ChecklistItem`s; a
 * Checkpoint is a strict superset, so existing consumers keep compiling.
 */
export type ChecklistItem = Checkpoint;

// ============================================================
// CATALOG
// ============================================================

export const CHECKLIST_CATALOG: Record<InspectionCategory, ChecklistItem[]> = {
  fire_extinguisher: [
    { key: 'fex_valve_reassembled', label: 'Valve / collar reassembled & tightened to spec', scope: ['shop'], requiredInShop: false },
    { key: 'fex_pin_seal', label: 'Pull pin reinstalled; new tamper seal intact', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'fex_gauge_green', label: 'Pressure gauge needle in operable / green range', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'fex_weight_ok', label: 'Heft / weight correct — agent present', scope: ['shop'], requiredInShop: false },
    { key: 'fex_shell_ok', label: 'No corrosion, dents, leakage, or damage to shell / hose / nozzle / handle', scope: ['shop', 'field'], requiredInShop: true, input: { kind: 'functional' }, photo: 'on_fail', cascade: ['fex_shell_condemn'] },
    { key: 'fex_service_tag', label: 'Service tag applied — date + inspector initials', scope: ['shop'], requiredInShop: false },
    { key: 'fex_nozzle_clear', label: 'Nozzle and hose clear of obstruction', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'fex_label_legible', label: 'Nameplate / operating instructions legible', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'all_components_clean', label: 'Is it clean?', scope: ['shop'], requiredInShop: true },
    // Field-only — retained for a future field-inspection workflow.
    { key: 'fex_location', label: 'In designated location, visible, unobstructed', scope: ['field'], requiredInShop: false },
    { key: 'fex_mount_height', label: 'Mounted at correct height; within required travel distance', scope: ['field'], requiredInShop: false },
    { key: 'fex_label_outward', label: 'Nameplate / instructions facing outward', scope: ['field'], requiredInShop: false },
    { key: 'fex_correct_type', label: 'Correct extinguisher type & rating for the hazard', scope: ['field'], requiredInShop: false },
  ],

  scba: [
    { key: 'scba_facepiece', label: 'Facepiece / lens — no cracks, tears, distortion, heat damage; clean', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'scba_harness', label: 'Head harness / straps intact, not frayed; buckles function', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'scba_valves', label: 'Inhalation / exhalation valves seated, undamaged, move freely', scope: ['shop'], requiredInShop: false },
    { key: 'scba_regulator', label: 'Regulator, bypass & purge operate correctly', scope: ['shop'], requiredInShop: false },
    { key: 'scba_alarm', label: 'Low-pressure & end-of-service-time alarm activates', scope: ['shop', 'field'], requiredInShop: true, input: { kind: 'functional' } },
    { key: 'scba_cylinder', label: 'Cylinder ≥ 90% rated pressure; hydro test date current', scope: ['shop', 'field'], requiredInShop: true, input: { kind: 'functional' }, cascade: ['scba_cylinder_hydro'] },
    { key: 'scba_connections_tight', label: 'All hoses / fittings / connections reassembled & TIGHTENED — no leaks', scope: ['shop'], requiredInShop: false },
    { key: 'scba_flow_test', label: 'Flow / posi-check / function test passed', scope: ['shop'], requiredInShop: true, input: { kind: 'functional' } },
    { key: 'scba_orings', label: 'Gaskets / O-rings pliable, not deteriorated', scope: ['shop'], requiredInShop: false },
    { key: 'all_components_clean', label: 'Is it clean?', scope: ['shop'], requiredInShop: true },
    { key: 'scba_documentation', label: 'Is all documentation (Posi, UE, etc) included and legible?', scope: ['shop'], requiredInShop: false },
  ],

  fall_arrest: [
    { key: 'fa_webbing', label: 'Webbing / rope / cable — no cuts, frays, burns, broken fibers, chemical / UV / corrosion', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'fa_stitching', label: 'Stitching — no pulled, cut, or broken threads', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'fa_hardware', label: 'D-rings / buckles — no cracks, distortion, corrosion; engage & hold', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'fa_indicator', label: 'Impact / fall-arrest indicator NOT deployed', scope: ['shop', 'field'], requiredInShop: true, input: { kind: 'functional' }, photo: 'on_fail', cascade: ['fa_indicator_deployed'] },
    { key: 'fa_energy_absorber', label: 'Energy absorber / shock pack — cover intact, NOT deployed or torn', scope: ['shop', 'field'], requiredInShop: true, input: { kind: 'functional' }, photo: 'on_fail', cascade: ['fa_absorber_deployed'] },
    { key: 'fa_srl_function', label: 'SRL (if applicable): extends & retracts smoothly; lockup test — sharp pull locks the brake', scope: ['shop'], requiredInShop: true, subTypes: ['srl'], input: { kind: 'functional' }, cascade: ['fa_srl_factory'] },
    { key: 'fa_connectors_tight', label: 'All connectors / fasteners reassembled & TIGHTENED; snap-hook / carabiner gates close & self-lock', scope: ['shop'], requiredInShop: false },
    { key: 'fa_labels', label: 'Labels present and legible (capacity, mfr date, standard)', scope: ['shop', 'field'], requiredInShop: false },
    // Field-only — retained for a future field-inspection workflow.
    { key: 'fa_anchorage', label: 'Anchorage rated ≥ 5,000 lb / engineered; secure', scope: ['field'], requiredInShop: false },
    { key: 'fa_fall_clearance', label: 'Adequate fall clearance / fall-distance verified', scope: ['field'], requiredInShop: false },
    { key: 'fa_rescue_plan', label: 'Rescue plan in place', scope: ['field'], requiredInShop: false },
    { key: 'all_components_clean', label: 'Is it clean?', scope: ['shop'], requiredInShop: true },
  ],

  gas_detection: [
    { key: 'gas_physical', label: 'Physical condition — no cracks, damage, or moisture intrusion', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'gas_ports', label: 'Sensor ports / intake clear and unobstructed', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'gas_battery', label: 'Battery charged for full shift', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'gas_display', label: 'Display functioning; zeroes in clean / fresh air', scope: ['shop'], requiredInShop: false },
    { key: 'gas_sensors', label: 'Correct sensors for hazard with correct alarm setpoints', scope: ['shop'], requiredInShop: false },
    { key: 'gas_bump', label: 'Bump test passes — sensors respond AND all alarms activate (audible / visual / vibrate)', scope: ['shop', 'field'], requiredInShop: true, input: { kind: 'functional' } },
    { key: 'gas_pump', label: 'Pump and filters functioning (pumped instruments)', scope: ['shop'], requiredInShop: false },
    { key: 'gas_clip', label: 'Clip / case secure; fasteners tight', scope: ['shop'], requiredInShop: false },
    { key: 'all_components_clean', label: 'Is it clean?', scope: ['shop'], requiredInShop: true },
  ],

  ue_cylinder: [
    { key: 'ue_visual', label: 'Cylinder exterior — no gouges, corrosion, heat / fire damage', scope: ['shop'], requiredInShop: true, input: { kind: 'functional' }, photo: 'on_fail', cascade: ['ue_visual_condemn'] },
    { key: 'ue_test_done', label: 'UE / hydro test performed; result recorded', scope: ['shop'], requiredInShop: false, appliesToActions: ['ue_test', 'hydro'] },
    { key: 'ue_valve_tight', label: 'Valve reinstalled & TIGHTENED to spec; no leaks', scope: ['shop'], requiredInShop: false, appliesToActions: ['ue_test', 'hydro', 'parts_replaced'] },
    { key: 'ue_stamp', label: 'Test date / stamp applied', scope: ['shop'], requiredInShop: false, appliesToActions: ['ue_test', 'hydro'] },
    { key: 'all_components_clean', label: 'Is it clean?', scope: ['shop'], requiredInShop: true },
  ],

  breathing_air_system: [
    { key: 'bas_grade_d', label: 'Air meets Grade D (O₂ 19.5–23.5%, CO ≤ 10 ppm, CO₂ ≤ 1,000 ppm, no odor)', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'bas_co_alarm', label: 'CO monitor / alarm functional and in calibration', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'bas_filters', label: 'Sorbent beds / filters maintained or replaced; change tag updated — date + signature', scope: ['shop'], requiredInShop: false },
    { key: 'bas_couplings', label: 'Breathing-air couplings INCOMPATIBLE with shop air / other gas systems', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'bas_hoses_tight', label: 'Hoses, fittings, regulators & manifolds reassembled & TIGHTENED; no damage or leaks', scope: ['shop'], requiredInShop: false },
    { key: 'bas_cylinders', label: 'Cylinders / cascade — adequate pressure, hydro date current', scope: ['shop', 'field'], requiredInShop: false },
    // Field-only — retained for a future field-inspection workflow.
    { key: 'bas_intake_location', label: 'Compressor intake located away from contaminant sources; not overheating', scope: ['field'], requiredInShop: false },
    { key: 'all_components_clean', label: 'Is it clean?', scope: ['shop'], requiredInShop: true },
  ],

  first_aid_kit: [
    { key: 'fak_class', label: 'Correct class for hazard (Class A / Class B)', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'fak_contents', label: 'All required contents present in minimum quantities', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'fak_expired', label: 'No expired items; seals and packaging intact', scope: ['shop', 'field'], requiredInShop: false },
    { key: 'fak_container', label: 'Container undamaged; weather / water seal good', scope: ['shop', 'field'], requiredInShop: false },
    // Field-only — retained for a future field-inspection workflow.
    { key: 'fak_mounted', label: 'Mounted / located per site requirement', scope: ['field'], requiredInShop: false },
    { key: 'all_components_clean', label: 'Is it clean?', scope: ['shop'], requiredInShop: true },
  ],

  other: [],
};

// ============================================================
// MAPPING + HELPERS
// ============================================================

const SHOP_TO_INSPECTION: Record<ShopEquipmentCategory, InspectionCategory> = {
  fire_extinguisher: 'fire_extinguisher',
  area_monitor: 'gas_detection',
  personal_monitor: 'gas_detection',
  fall_arrest: 'fall_arrest',
  scba: 'scba',
  ue_cylinder: 'ue_cylinder',
  other: 'other',
};

export function mapShopCategoryToInspection(
  shopCategory: string,
): InspectionCategory {
  return SHOP_TO_INSPECTION[shopCategory as ShopEquipmentCategory] ?? 'other';
}

/** Checklist items shown in the shop (scope includes 'shop'). */
export function getShopChecklist(category: InspectionCategory): ChecklistItem[] {
  const rank = (item: ChecklistItem) =>
    item.input?.kind === 'functional' || item.input?.kind === 'visual' ? 0
      : item.key === 'all_components_clean' ? 1 : 2;
  return (CHECKLIST_CATALOG[category] ?? [])
    .filter((i) => i.scope.includes('shop'))
    .sort((a, b) => rank(a) - rank(b));
}

function normalizeActions(serviceActions: unknown): string[] {
  return Array.isArray(serviceActions)
    ? serviceActions.filter((a): a is string => typeof a === 'string')
    : [];
}

/**
 * Whether a checklist item applies given the actions actually performed.
 * Items with no `appliesToActions` always apply; action-tagged items apply only
 * when at least one of their actions was performed. A Visual Only inspection
 * (no substantive action) leaves only the always-on checks required.
 */
export function itemApplies(item: ChecklistItem, serviceActions: unknown): boolean {
  if (!item.appliesToActions || item.appliesToActions.length === 0) return true;
  const acts = normalizeActions(serviceActions);
  return item.appliesToActions.some((a) => acts.includes(a));
}

/** Keys that must be checked true before an item can reach shop_complete. */
export function getRequiredShopKeys(
  category: InspectionCategory,
  serviceActions?: unknown,
): string[] {
  return (CHECKLIST_CATALOG[category] ?? [])
    .filter((i) => i.requiredInShop && i.scope.includes('shop'))
    .filter((i) => itemApplies(i, serviceActions))
    .map((i) => i.key);
}

/** Whether this category enforces a pre-pickup QA gate at all. */
export function categoryHasShopGate(category: InspectionCategory): boolean {
  return getRequiredShopKeys(category).length > 0;
}

/**
 * True when every required shop checklist item is affirmatively checked.
 * qaChecklist is the data.qaChecklist object: { [key]: boolean }.
 */
export function isQaChecklistComplete(
  category: InspectionCategory,
  qaChecklist: unknown,
  serviceActions?: unknown,
): boolean {
  const required = getRequiredShopKeys(category, serviceActions);
  if (required.length === 0) return true;
  const checks =
    qaChecklist && typeof qaChecklist === 'object'
      ? (qaChecklist as Record<string, unknown>)
      : {};
  return required.every((k) => checks[k] === true);
}

/** Required keys that are NOT yet satisfied — for building a clear error. */
export function getMissingRequiredShopKeys(
  category: InspectionCategory,
  qaChecklist: unknown,
  serviceActions?: unknown,
): string[] {
  const required = getRequiredShopKeys(category, serviceActions);
  const checks =
    qaChecklist && typeof qaChecklist === 'object'
      ? (qaChecklist as Record<string, unknown>)
      : {};
  return required.filter((k) => checks[k] !== true);
}

/** Human-readable labels for a set of checklist keys (for error messages). */
export function labelsForKeys(
  category: InspectionCategory,
  keys: string[],
): string[] {
  const byKey = new Map((CHECKLIST_CATALOG[category] ?? []).map((i) => [i.key, i.label]));
  return keys.map((k) => byKey.get(k) ?? k);
}

// ============================================================
// CASCADE RULES + ENGINE (ShopWork refactor, Wave 1)
// ============================================================
//
// A cascade fires when a checkpoint's recorded result meets a condition (and,
// optionally, the unit's attributes match). It DRIVES the workflow — routing the
// item (CONDEMN / FACTORY_RETURN), forcing parts onto the repair (FORCE_PARTS),
// or making the tech acknowledge a verbatim manual snippet (REQUIRE_ACK). The
// structured action is authoritative; the manual sentence is quoted, never
// paraphrased.
//
// FORCE_PARTS part numbers come from the mfr manuals via a RAG extract. Where the
// extract has not landed (notably Fall Arrest — §8 blocker) the parts list is
// intentionally empty; the CONDEMN / FACTORY_RETURN actions need no P/N and are
// defined now. This engine is PURE so it mirrors to the client and the editor can
// surface cascades live as results are recorded.

export type CascadeResultCondition =
  | 'fail'
  | 'pass'
  | { measuredBelow: number }
  | { measuredAbove: number }
  | { equals: string };

export type CascadeActionType =
  | 'CONDEMN'
  | 'FORCE_PARTS'
  | 'REQUIRE_ACK'
  | 'FACTORY_RETURN';

export interface CascadeRule {
  id: string;
  /** Checkpoint whose recorded result is evaluated. */
  checkpointKey: string;
  /** Condition on the recorded result that fires the rule. */
  condition: CascadeResultCondition;
  /**
   * Optional unit-attribute gate. Each entry is a case-insensitive substring
   * match against the like-named attribute on the unit (e.g. { model: 'SRL' }
   * fires only when the unit model contains "SRL"). Omit ⇒ fires regardless.
   */
  unitAttrs?: Record<string, string>;
  action: CascadeActionType;
  /** P/Ns forced onto the repair for FORCE_PARTS. */
  parts?: string[];
  /** Verbatim manual snippet shown for REQUIRE_ACK (and in the reference pane). */
  ackText?: string;
  /** Source manual pointer — quoted verbatim, snapshotted at lock. */
  sourceRef?: ManualRef;
}

export const CASCADE_RULES: Record<InspectionCategory, CascadeRule[]> = {
  fire_extinguisher: [
    { id: 'fex_shell_condemn', checkpointKey: 'fex_shell_ok', condition: 'fail', action: 'CONDEMN' },
  ],
  scba: [
    // Hydro recert can't be done in-house — the cylinder leaves for the OEM/test house.
    { id: 'scba_cylinder_hydro', checkpointKey: 'scba_cylinder', condition: 'fail', action: 'FACTORY_RETURN' },
  ],
  fall_arrest: [
    // ANSI/OSHA-shaped, no P/N needed — defined now even though FA guts are blocked (§8).
    { id: 'fa_indicator_deployed', checkpointKey: 'fa_indicator', condition: 'fail', action: 'CONDEMN' },
    { id: 'fa_absorber_deployed', checkpointKey: 'fa_energy_absorber', condition: 'fail', action: 'CONDEMN' },
    { id: 'fa_srl_factory', checkpointKey: 'fa_srl_function', condition: 'fail', action: 'FACTORY_RETURN' },
  ],
  gas_detection: [],
  ue_cylinder: [
    { id: 'ue_visual_condemn', checkpointKey: 'ue_visual', condition: 'fail', action: 'CONDEMN' },
  ],
  breathing_air_system: [],
  first_aid_kit: [],
  other: [],
};

/** A recorded checkpoint result, as stored in inspection data.checkpoints[key].value. */
export type CheckpointResultValue = boolean | number | string | null | undefined;

export interface CascadeAction {
  ruleId: string;
  checkpointKey: string;
  action: CascadeActionType;
  parts?: string[];
  ackText?: string;
  sourceRef?: ManualRef;
}

/**
 * Normalize a recorded result to "failed the check". Checkpoints are phrased
 * positively (e.g. "indicator NOT deployed"), so `false` / "fail" / "deployed"
 * mean the bad condition is present. An unrecorded (undefined) result never fails.
 */
function resultIsFail(value: CheckpointResultValue): boolean {
  if (value === false) return true;
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    return v === 'fail' || v === 'failed' || v === 'no' || v === 'deployed';
  }
  return false;
}

function resultIsPass(value: CheckpointResultValue): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    return v === 'pass' || v === 'passed' || v === 'yes' || v === 'ok';
  }
  return false;
}

function conditionMatches(cond: CascadeResultCondition, value: CheckpointResultValue): boolean {
  if (cond === 'fail') return resultIsFail(value);
  if (cond === 'pass') return resultIsPass(value);
  if (typeof cond === 'object') {
    if ('measuredBelow' in cond) return typeof value === 'number' && value < cond.measuredBelow;
    if ('measuredAbove' in cond) return typeof value === 'number' && value > cond.measuredAbove;
    if ('equals' in cond) return value != null && String(value) === cond.equals;
  }
  return false;
}

function unitAttrsMatch(
  ruleAttrs: Record<string, string> | undefined,
  unitAttrs: Record<string, unknown> | undefined,
): boolean {
  if (!ruleAttrs) return true;
  const attrs = unitAttrs ?? {};
  return Object.entries(ruleAttrs).every(([k, needle]) => {
    const have = attrs[k];
    return typeof have === 'string' && have.toLowerCase().includes(needle.toLowerCase());
  });
}

/**
 * Evaluate cascade rules for a category against recorded checkpoint results.
 * `results` maps checkpointKey → recorded value (data.checkpoints[key].value).
 * Returns the structured actions that fire. Pure — safe to mirror to the client.
 */
export function evaluateCascades(
  category: InspectionCategory,
  results: Record<string, CheckpointResultValue> | null | undefined,
  unitAttrs?: Record<string, unknown>,
): CascadeAction[] {
  const rules = CASCADE_RULES[category] ?? [];
  const out: CascadeAction[] = [];
  for (const rule of rules) {
    const value = results ? results[rule.checkpointKey] : undefined;
    if (value === undefined) continue;
    if (!conditionMatches(rule.condition, value)) continue;
    if (!unitAttrsMatch(rule.unitAttrs, unitAttrs)) continue;
    out.push({
      ruleId: rule.id,
      checkpointKey: rule.checkpointKey,
      action: rule.action,
      parts: rule.parts,
      ackText: rule.ackText,
      sourceRef: rule.sourceRef,
    });
  }
  return out;
}

/** The catalog checkpoints for a category (optionally filtered to a sub-type). */
export function getCheckpoints(
  category: InspectionCategory,
  subType?: string,
): Checkpoint[] {
  const all = CHECKLIST_CATALOG[category] ?? [];
  if (!subType) return all;
  return all.filter((c) => !c.subTypes || c.subTypes.includes(subType));
}

/**
 * Pull recorded checkpoint result values out of an inspection's data blob.
 * The editor stores `data.checkpoints[key] = { value, photoIds?, ack? }`; older
 * records may store the bare value. Returns a flat { key → value } map for the
 * cascade engine and the QA-derivation.
 */
export function extractCheckpointResults(
  data: unknown,
): Record<string, CheckpointResultValue> {
  const out: Record<string, CheckpointResultValue> = {};
  const cps = (data as { checkpoints?: Record<string, unknown> } | null)?.checkpoints;
  if (cps && typeof cps === 'object') {
    for (const [k, v] of Object.entries(cps)) {
      if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
        out[k] = (v as { value: CheckpointResultValue }).value;
      } else {
        out[k] = v as CheckpointResultValue;
      }
    }
  }
  return out;
}

/** A captured manual reference for the audit snapshot. */
export interface ManualRefSnapshotEntry extends ManualRef {
  key: string;
}

/**
 * Manual references for the checkpoints of a category — the audit-snapshot spine.
 * Captured into the inspection record at lock so the BlueLion ledger entry is
 * defensible (which manual revision the criteria came from). Empty until the RAG
 * extract populates `manualRef` on the catalog checkpoints (§7/§8).
 */
export function manualRefsForCategory(
  category: InspectionCategory,
  subType?: string,
): ManualRefSnapshotEntry[] {
  return getCheckpoints(category, subType)
    .filter((c) => c.manualRef)
    .map((c) => ({ key: c.key, ...(c.manualRef as ManualRef) }));
}

/** The cascade rules registered for a category. */
export function getCascadeRules(category: InspectionCategory): CascadeRule[] {
  return CASCADE_RULES[category] ?? [];
}

// Categories where a re-test (final inspection) re-verifies EVERYTHING because the
// unit was disturbed; others re-verify only the previously-failed checkpoints.
// (Spec §2 risk-tiered re-test scope.)
const FULL_RETEST_CATEGORIES: ReadonlySet<InspectionCategory> = new Set<InspectionCategory>([
  'scba',
  'fall_arrest',
]);

/** Whether a re-test of this category re-renders the full checkpoint set. */
export function retestIsFullScope(category: InspectionCategory): boolean {
  return FULL_RETEST_CATEGORIES.has(category);
}

// ============================================================
// CHECKLIST VERSION (WI-06)
// ============================================================
//
// A batch QA record has to say WHICH criteria it was run against, or a Vault
// record that outlives three catalog revisions is unreadable: "all checks
// passed" means nothing without the list of checks.
//
// DERIVED, NOT DECLARED. A hand-bumped `CATALOG_VERSION = '1.4'` is a version
// number that is wrong the first time somebody edits a label and forgets it —
// and a version that lies is worse than no version, because it is trusted.
// Hashing the content cannot drift from the content.
//
// FNV-1a rather than a real digest because this file is mirrored verbatim to
// the client (see the header) and must stay import-free. This is not a security
// boundary; it is a change detector, and a 32-bit hash detects a changed
// checklist perfectly well. The full checkpoint set is inlined into the Vault
// snapshot anyway — the hash is the index, not the evidence.

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range without BigInt.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A stable fingerprint of the shop-scoped checkpoints for a category.
 *
 * Covers key, label and requiredInShop — the three things that change what a
 * "pass" actually asserted. Reordering the catalog does NOT change the hash
 * (the keys are sorted first), because moving a row up the list does not change
 * what was inspected.
 */
export function checklistVersion(category: InspectionCategory): string {
  const spine = getShopChecklist(category)
    .map((i) => `${i.key}:${i.requiredInShop ? 1 : 0}:${i.label}`)
    .sort()
    .join('|');
  return `${category}-${fnv1a(spine)}`;
}

/**
 * The shop checkpoints for a category as plain, self-contained data — what gets
 * inlined into a Vault snapshot so the record stands alone forever.
 */
export function checklistSnapshotFor(
  category: InspectionCategory,
  serviceActions?: unknown,
): Array<{ key: string; label: string; required: boolean }> {
  const required = new Set(getRequiredShopKeys(category, serviceActions));
  return getShopChecklist(category).map((i) => ({
    key: i.key,
    label: i.label,
    required: required.has(i.key),
  }));
}
