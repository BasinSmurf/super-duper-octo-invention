/**
 * novaraEquipmentSync.ts
 *
 * Pulls equipment + inspection compliance from Novara Flex into SP. One-way;
 * nothing is ever pushed back.
 *
 * SHAPE OF THE PULL
 *   Novara's `equipments.list` requires an equipmentType_id, so a full run is
 *   `equipmenttypes.list` followed by one call per enabled type. That is also
 *   the whole request budget: their limit is ~80/min across the entire customer
 *   account, so the sync deliberately does NOT call `inspections.list` (one
 *   call per UNIT would blow the budget on the first few hundred units).
 *   Compliance comes off the `status` + `schedules` already embedded in the
 *   equipments.list rows, which is exactly what the docs say those fields are
 *   for: "If any schedule is expired then the overall status will be expired."
 *
 * WHAT NOVARA OWNS
 *   The novara* columns on SerializedEquipment, and — indirectly — two SP
 *   fields:
 *     - `status`, but ONLY the available <-> out_of_service edge, and only
 *       while `novaraServiceHold` says this sync is the one holding it. A unit
 *       that is deployed / rented / in repair / condemned is never touched:
 *       Novara does not know about our rental workflow, and a compliance system
 *       yanking a unit out from under an active agreement would be worse than
 *       the stale flag it is trying to fix.
 *     - `calibrationDueDate` / `bumpTestDueDate`, but only for schedules an
 *       admin has explicitly pointed at those columns (NovaraScheduleMap).
 *       Novara schedule names are free text, so guessing which one is "the
 *       calibration" would silently write wrong dates onto units techs trust.
 *
 * WHAT IT REFUSES TO DO
 *   Create a unit whose Novara type has no product mapping. SerializedEquipment
 *   requires a productId and an ownership, and neither is knowable from Novara.
 *   Those units land in NovaraSyncIssue for a human, and the queue self-drains
 *   on the next run once the mapping exists.
 */

import { prisma } from '../db.js';
import { runScheduledJob } from './jobs.js';
import { heartbeat } from './supervisor.js';
import {
  isConfigured,
  listEquipment,
  listEquipmentTypes,
  type NovaraEquipment,
  type NovaraEquipmentSchedule,
} from './novaraClient.js';

const ENABLED = process.env.NOVARA_SYNC_ENABLED !== 'false';
export const INTERVAL_MS = parseInt(process.env.NOVARA_SYNC_INTERVAL_MS || '3600000', 10); // hourly

/**
 * SP status values the sync is allowed to move to out_of_service. Everything
 * else means a human or another workflow has a claim on the unit.
 */
const HOLDABLE_STATUSES = new Set(['available']);

/** SP date columns a Novara schedule may be pointed at. Mirrored in routes/novara.ts. */
export const SP_DATE_TARGETS = ['calibrationDueDate', 'bumpTestDueDate'] as const;
export type SpDateTarget = (typeof SP_DATE_TARGETS)[number];

export interface NovaraSyncSummary {
  typesSeen: number;
  typesSynced: number;
  typesUnmapped: number;
  typesSkipped: number;
  equipmentSeen: number;
  created: number;
  updated: number;
  unchanged: number;
  issues: number;
  issuesResolved: number;
  parentsLinked: number;
  dryRun: boolean;
  errors: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Epoch millis -> a UTC-midnight Date for a @db.Date column.
 *
 * Novara stamps these in the site's local timezone; storing the raw instant and
 * letting Postgres cast it would shift an evening expiry back a day for anyone
 * west of UTC. Pinning to UTC midnight of the local calendar date keeps
 * "expires the 30th" reading as the 30th.
 */
function epochToDateOnly(ms: number | null | undefined): Date | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function minDate(dates: (Date | null)[]): Date | null {
  const valid = dates.filter((d): d is Date => d !== null);
  if (!valid.length) return null;
  return valid.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
}

function maxDate(dates: (Date | null)[]): Date | null {
  const valid = dates.filter((d): d is Date => d !== null);
  if (!valid.length) return null;
  return valid.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

function sameDay(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/**
 * Roll the per-schedule statuses up to one unit status.
 *
 * Novara already sends a top-level `status`; this is the fallback for when a
 * caller trimmed it out with `columns`, and it applies their documented rule —
 * any expired schedule makes the whole unit expired.
 */
function rollupStatus(eq: NovaraEquipment): string | null {
  if (eq.status) return eq.status;
  const statuses = (eq.schedules ?? []).map(s => s.status).filter(Boolean);
  if (!statuses.length) return null;
  if (statuses.includes('expired')) return 'expired';
  if (statuses.includes('expiring')) return 'expiring';
  return 'uptodate';
}

/** Per-schedule detail, ISO-dated, so the UI can name WHICH inspection lapsed. */
function compactSchedules(
  schedules: NovaraEquipmentSchedule[],
  names: Map<string, string | null>,
): { scheduleId: string; name: string | null; status: string | null; expiresOn: string | null; expiringOn: string | null; lastCompletedOn: string | null }[] {
  return schedules.map(s => ({
    scheduleId: s.schedule_id,
    name: names.get(s.schedule_id) ?? null,
    status: s.status ?? null,
    expiresOn: epochToDateOnly(s.expiresOn)?.toISOString().slice(0, 10) ?? null,
    expiringOn: epochToDateOnly(s.expiringOn)?.toISOString().slice(0, 10) ?? null,
    lastCompletedOn: epochToDateOnly(s.lastCompletedOn)?.toISOString().slice(0, 10) ?? null,
  }));
}

/** Novara serials arrive with stray whitespace often enough to be worth trimming. */
function normalizeSerial(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  return s.length ? s : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue queue
// ─────────────────────────────────────────────────────────────────────────────

type IssueReason =
  | 'unmapped_type'
  | 'auto_create_off'
  | 'missing_serial'
  | 'serial_conflict'
  | 'parent_unresolved'
  | 'parent_not_assembly';

async function recordIssue(
  eq: NovaraEquipment,
  typeTitle: string,
  reason: IssueReason,
  detail: string,
  now: Date,
): Promise<void> {
  await prisma.novaraSyncIssue.upsert({
    where: { novaraEquipmentId: eq.id },
    create: {
      novaraEquipmentId: eq.id,
      novaraTypeId: eq.equipmentType_id,
      novaraTypeTitle: typeTitle,
      serialNumber: normalizeSerial(eq.serialNumber),
      novaraTitle: eq.title ?? null,
      reason,
      detail,
      lastSeenAt: now,
    },
    update: {
      novaraTypeTitle: typeTitle,
      serialNumber: normalizeSerial(eq.serialNumber),
      novaraTitle: eq.title ?? null,
      reason,
      detail,
      lastSeenAt: now,
      // A unit that regressed into a NEW problem is open again.
      resolvedAt: null,
    },
  });
}

/** Stamp an open issue resolved once the unit finally lands. */
async function clearIssue(novaraEquipmentId: string, now: Date): Promise<boolean> {
  const { count } = await prisma.novaraSyncIssue.updateMany({
    where: { novaraEquipmentId, resolvedAt: null },
    data: { resolvedAt: now },
  });
  return count > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type + schedule catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirror Novara's type + schedule catalog into our mapping tables.
 *
 * Discovery is additive and non-destructive: a type that disappears from Novara
 * keeps its row (and its product mapping) so that re-adding it upstream doesn't
 * mean re-mapping it here. `lastSeenAt` is how the admin page shows staleness.
 */
async function refreshCatalog(now: Date): Promise<{ typesSeen: number; scheduleNames: Map<string, string | null> }> {
  const types = await listEquipmentTypes();
  const scheduleNames = new Map<string, string | null>();

  for (const t of types) {
    await prisma.novaraEquipmentTypeMap.upsert({
      where: { novaraTypeId: t.id },
      create: { novaraTypeId: t.id, novaraTypeTitle: t.title, lastSeenAt: now },
      // Only the title and last-seen refresh — productId / autoCreate /
      // ownership / syncEnabled are human decisions and must survive a run.
      update: { novaraTypeTitle: t.title, lastSeenAt: now },
    });

    for (const s of t.schedules ?? []) {
      scheduleNames.set(s.id, s.name ?? null);
      await prisma.novaraScheduleMap.upsert({
        where: { novaraScheduleId: s.id },
        create: {
          novaraTypeId: t.id,
          novaraScheduleId: s.id,
          novaraScheduleName: s.name ?? null,
          lastSeenAt: now,
        },
        update: { novaraScheduleName: s.name ?? null, lastSeenAt: now },
      });
    }
  }

  return { typesSeen: types.length, scheduleNames };
}

// ─────────────────────────────────────────────────────────────────────────────
// The sync
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncOptions {
  /** Walk everything and report, but write nothing. For a first look pre-mapping. */
  dryRun?: boolean;
  /** Restrict to specific Novara type ids. Empty/omitted = every enabled type. */
  typeIds?: string[];
}

export async function syncNovaraEquipment(opts: SyncOptions = {}): Promise<NovaraSyncSummary> {
  const dryRun = !!opts.dryRun;
  const now = new Date();
  const summary: NovaraSyncSummary = {
    typesSeen: 0,
    typesSynced: 0,
    typesUnmapped: 0,
    typesSkipped: 0,
    equipmentSeen: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    issues: 0,
    issuesResolved: 0,
    parentsLinked: 0,
    dryRun,
    errors: [],
  };

  if (!isConfigured()) throw new Error('Novara is not configured (NOVARA_API_TOKEN unset)');

  // The catalog refresh writes, so a dry run reads the catalog without
  // persisting it — otherwise "change nothing" would still create dozens of rows.
  let scheduleNames = new Map<string, string | null>();
  if (dryRun) {
    const types = await listEquipmentTypes();
    summary.typesSeen = types.length;
    for (const t of types) for (const s of t.schedules ?? []) scheduleNames.set(s.id, s.name ?? null);
  } else {
    const catalog = await refreshCatalog(now);
    summary.typesSeen = catalog.typesSeen;
    scheduleNames = catalog.scheduleNames;
  }

  const typeMaps = await prisma.novaraEquipmentTypeMap.findMany({
    where: opts.typeIds?.length ? { novaraTypeId: { in: opts.typeIds } } : undefined,
    orderBy: { novaraTypeTitle: 'asc' },
  });

  // scheduleId -> SP column, for the schedules an admin has wired up.
  const scheduleTargets = new Map<string, SpDateTarget>();
  for (const s of await prisma.novaraScheduleMap.findMany({ where: { targetField: { not: null } } })) {
    if ((SP_DATE_TARGETS as readonly string[]).includes(s.targetField!)) {
      scheduleTargets.set(s.novaraScheduleId, s.targetField as SpDateTarget);
    }
  }

  const parentLinks: { eq: NovaraEquipment; typeTitle: string; novaraParentId: string }[] = [];

  for (const typeMap of typeMaps) {
    if (!typeMap.syncEnabled) {
      summary.typesSkipped++;
      continue;
    }

    let equipments: NovaraEquipment[];
    try {
      equipments = await listEquipment(typeMap.novaraTypeId, { serviceType: 'all' });
    } catch (err) {
      // One bad type must not abandon the rest of the catalog — record it and
      // keep going, so a single retired type id can't stall every other unit.
      const message = `type ${typeMap.novaraTypeTitle}: ${err instanceof Error ? err.message : String(err)}`;
      summary.errors.push(message.slice(0, 500));
      console.warn(`[Novara] ${message}`);
      continue;
    }

    summary.equipmentSeen += equipments.length;
    if (!typeMap.productId) summary.typesUnmapped++;
    else summary.typesSynced++;

    if (!dryRun) {
      await prisma.novaraEquipmentTypeMap.update({
        where: { id: typeMap.id },
        data: { equipmentCount: equipments.length, lastSeenAt: now },
      });
    }

    for (const eq of equipments) {
      try {
        // Parentage is resolved in a SECOND pass: Novara's parent may belong to
        // a type we haven't walked yet, so its SP row might not exist during
        // this one. Collected here, applied by linkParents() below.
        if (eq.parent_id) parentLinks.push({ eq, typeTitle: typeMap.novaraTypeTitle, novaraParentId: eq.parent_id });

        const outcome = await applyEquipment(eq, typeMap, scheduleNames, scheduleTargets, now, dryRun);
        if (outcome === 'created') summary.created++;
        else if (outcome === 'updated') summary.updated++;
        else if (outcome === 'unchanged') summary.unchanged++;
        else summary.issues++;
        if (outcome === 'created' || outcome === 'updated' || outcome === 'unchanged') {
          if (!dryRun && (await clearIssue(eq.id, now))) summary.issuesResolved++;
        }
      } catch (err) {
        const message = `equipment ${eq.serialNumber ?? eq.id}: ${err instanceof Error ? err.message : String(err)}`;
        summary.errors.push(message.slice(0, 500));
        console.warn(`[Novara] ${message}`);
      }
    }
  }

  await linkParents(parentLinks, now, dryRun, summary);

  if (!dryRun) {
    await prisma.novaraSyncState.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', lastRunAt: now, lastSummary: summary as unknown as object, lastError: null },
      update: {
        lastRunAt: now,
        lastSummary: summary as unknown as object,
        lastError: summary.errors.length ? summary.errors[0]!.slice(0, 2000) : null,
      },
    });
  }

  console.log(
    `[Novara] sync ${dryRun ? '(dry run) ' : ''}done — ${summary.equipmentSeen} units across ${summary.typesSeen} types: ` +
      `${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged, ` +
      `${summary.parentsLinked} re-parented, ${summary.issues} needing review`,
  );

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parentage (SafeCore under BZ1, bottle under trailer, …)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply Novara's `parent_id` to SP's `parentEquipmentId`.
 *
 * NOVARA WINS, BUT ONLY WHEN IT SPEAKS. A unit that Novara gives a parent for
 * is re-parented on every run, overwriting whatever SP had — that is the
 * "override from Novara" half. A unit Novara says nothing about is left
 * completely alone, which is the "allow movement" half: a tech swapping a
 * SafeCore between BZ1 towers in SP keeps that change until and unless Novara
 * asserts something different. Novara clearing a parent does NOT orphan the SP
 * unit; absence is silence, not an instruction.
 *
 * Runs as a second pass because Novara's parent may live in a type this run
 * walks later (or in a type that is mapped while the child's is not), so the
 * parent's SP row can't be assumed to exist during the first pass.
 */
async function linkParents(
  links: { eq: NovaraEquipment; typeTitle: string; novaraParentId: string }[],
  now: Date,
  dryRun: boolean,
  summary: NovaraSyncSummary,
): Promise<void> {
  if (!links.length) return;

  const novaraIds = [...new Set(links.flatMap(l => [l.eq.id, l.novaraParentId]))];
  const units = await prisma.serializedEquipment.findMany({
    where: { novaraEquipmentId: { in: novaraIds } },
    select: {
      id: true,
      novaraEquipmentId: true,
      serialNumber: true,
      parentEquipmentId: true,
      product: { select: { isAssembly: true, name: true } },
    },
  });
  const byNovaraId = new Map(units.map(u => [u.novaraEquipmentId!, u]));

  for (const link of links) {
    const child = byNovaraId.get(link.eq.id);
    // Child never landed — it already has its own issue row (unmapped type,
    // missing serial, …). Don't pile a second, more confusing one on top.
    if (!child) continue;

    const parent = byNovaraId.get(link.novaraParentId);

    if (!parent) {
      if (!dryRun) {
        await recordIssue(
          link.eq,
          link.typeTitle,
          'parent_unresolved',
          `Novara parent ${link.novaraParentId} has no SP unit — map that parent's type, then re-run`,
          now,
        );
      }
      summary.issues++;
      continue;
    }

    if (parent.id === child.id) continue; // Novara self-parent; nothing sane to do

    // SP only lets a unit hang off an assembly, and the equipment page only
    // renders its Assembly section for one. Writing the link anyway would put
    // the unit somewhere no human could see or undo it.
    if (!parent.product.isAssembly) {
      if (!dryRun) {
        await recordIssue(
          link.eq,
          link.typeTitle,
          'parent_not_assembly',
          `Parent ${parent.serialNumber} is a "${parent.product.name}", which is not marked as an assembly product`,
          now,
        );
      }
      summary.issues++;
      continue;
    }

    if (child.parentEquipmentId === parent.id) continue; // already correct

    // Cycle guard: SP's own assign route has none, and a cycle here would make
    // the assembly drill-down recurse forever.
    if (await wouldCycle(parent.id, child.id)) {
      summary.errors.push(`parent cycle refused: ${child.serialNumber} under ${parent.serialNumber}`);
      continue;
    }

    if (dryRun) {
      summary.parentsLinked++;
      continue;
    }

    await prisma.serializedEquipment.update({
      where: { id: child.id },
      data: { parentEquipmentId: parent.id },
    });
    summary.parentsLinked++;
    console.log(`[Novara] ${child.serialNumber} re-parented under ${parent.serialNumber}`);
  }
}

/** True if making `childId` a child of `parentId` would close a loop. */
async function wouldCycle(parentId: string, childId: string): Promise<boolean> {
  let cursor: string | null = parentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === childId) return true;
    if (seen.has(cursor)) return true; // pre-existing loop; refuse to add to it
    seen.add(cursor);
    const row: { parentEquipmentId: string | null } | null =
      await prisma.serializedEquipment.findUnique({
        where: { id: cursor },
        select: { parentEquipmentId: true },
      });
    cursor = row?.parentEquipmentId ?? null;
  }
  return false;
}

type ApplyOutcome = 'created' | 'updated' | 'unchanged' | 'issue';

/**
 * Land one Novara unit onto SP.
 *
 * Matching is by Novara id first (survives a serial being corrected upstream),
 * then by serial number. A serial that already belongs to a DIFFERENT Novara id
 * is a conflict, not a merge — two Novara records claiming one SP unit needs a
 * human, because silently re-pointing the link would flip that unit's
 * compliance between two sources on alternating runs.
 */
async function applyEquipment(
  eq: NovaraEquipment,
  typeMap: { id: string; novaraTypeId: string; novaraTypeTitle: string; productId: string | null; ownership: 'basin_safety' | 'customer_owned'; autoCreate: boolean },
  scheduleNames: Map<string, string | null>,
  scheduleTargets: Map<string, SpDateTarget>,
  now: Date,
  dryRun: boolean,
): Promise<ApplyOutcome> {
  const serial = normalizeSerial(eq.serialNumber);
  const schedules = eq.schedules ?? [];

  // ── Derived compliance state ──────────────────────────────────────────────
  const novaraStatus = rollupStatus(eq);
  const expiresOn = minDate(schedules.map(s => epochToDateOnly(s.expiresOn)));
  const expiringOn = minDate(schedules.map(s => epochToDateOnly(s.expiringOn)));
  const lastCompletedOn = maxDate(schedules.map(s => epochToDateOnly(s.lastCompletedOn)));
  const novaraInService = eq.isInService ?? null;

  // ── Schedule-mapped SP due dates ──────────────────────────────────────────
  // Earliest wins when two schedules point at the same column: the due date a
  // tech acts on should be the next one, not whichever happened to sort last.
  const dateWrites: Partial<Record<SpDateTarget, Date | null>> = {};
  for (const s of schedules) {
    const target = scheduleTargets.get(s.schedule_id);
    if (!target) continue;
    const due = epochToDateOnly(s.expiresOn);
    if (!due) continue;
    const current = dateWrites[target];
    if (!current || due.getTime() < current.getTime()) dateWrites[target] = due;
  }

  const mirrored = {
    novaraEquipmentId: eq.id,
    novaraStatus,
    novaraExpiresOn: expiresOn,
    novaraExpiringOn: expiringOn,
    novaraLastCompletedOn: lastCompletedOn,
    novaraInService,
    novaraSchedules: compactSchedules(schedules, scheduleNames) as unknown as object,
    novaraSyncedAt: now,
    ...dateWrites,
  };

  // ── Find the SP unit ──────────────────────────────────────────────────────
  let existing = await prisma.serializedEquipment.findUnique({
    where: { novaraEquipmentId: eq.id },
    select: { id: true, serialNumber: true, status: true, novaraServiceHold: true, novaraStatus: true, novaraExpiresOn: true, novaraInService: true },
  });

  if (!existing && serial) {
    const bySerial = await prisma.serializedEquipment.findFirst({
      where: { serialNumber: { equals: serial, mode: 'insensitive' } },
      select: { id: true, serialNumber: true, status: true, novaraServiceHold: true, novaraStatus: true, novaraExpiresOn: true, novaraInService: true, novaraEquipmentId: true },
    });
    if (bySerial?.novaraEquipmentId && bySerial.novaraEquipmentId !== eq.id) {
      if (!dryRun) {
        await recordIssue(
          eq,
          typeMap.novaraTypeTitle,
          'serial_conflict',
          `SP unit ${bySerial.serialNumber} is already linked to Novara id ${bySerial.novaraEquipmentId}`,
          now,
        );
      }
      return 'issue';
    }
    existing = bySerial;
  }

  // ── Create ────────────────────────────────────────────────────────────────
  if (!existing) {
    if (!serial) {
      if (!dryRun) {
        await recordIssue(eq, typeMap.novaraTypeTitle, 'missing_serial', 'Novara record has no serial number to match on', now);
      }
      return 'issue';
    }
    if (!typeMap.productId) {
      if (!dryRun) {
        await recordIssue(
          eq,
          typeMap.novaraTypeTitle,
          'unmapped_type',
          `Novara type "${typeMap.novaraTypeTitle}" has no SP product mapping`,
          now,
        );
      }
      return 'issue';
    }
    if (!typeMap.autoCreate) {
      if (!dryRun) {
        await recordIssue(
          eq,
          typeMap.novaraTypeTitle,
          'auto_create_off',
          `Auto-create is off for Novara type "${typeMap.novaraTypeTitle}"`,
          now,
        );
      }
      return 'issue';
    }

    if (dryRun) return 'created';

    const outOfService = novaraInService === false;
    await prisma.serializedEquipment.create({
      data: {
        productId: typeMap.productId,
        serialNumber: serial,
        ownership: typeMap.ownership,
        status: outOfService ? 'out_of_service' : 'available',
        // A unit born out-of-service is born under our hold, so Novara putting
        // it back in service later is what lifts it — not a guess by whoever
        // next opens the record.
        novaraServiceHold: outOfService,
        conditionNotes: eq.notes ?? null,
        ...mirrored,
      },
    });
    console.log(`[Novara] created ${serial} (${typeMap.novaraTypeTitle})`);
    return 'created';
  }

  // ── Update ────────────────────────────────────────────────────────────────
  const data: Record<string, unknown> = { ...mirrored };

  // In/out of service — the ONE SP-owned field Novara may move, and only
  // between available and out_of_service. deployed / rented / repair /
  // condemned / retired / lost / in_transit are left strictly alone.
  if (novaraInService === false) {
    if (!existing.novaraServiceHold && HOLDABLE_STATUSES.has(existing.status)) {
      data.status = 'out_of_service';
      data.novaraServiceHold = true;
    }
  } else if (novaraInService === true && existing.novaraServiceHold) {
    // Only lift a status we ourselves set. If a human has since moved the unit
    // somewhere real, drop the hold and leave their status alone.
    if (existing.status === 'out_of_service') data.status = 'available';
    data.novaraServiceHold = false;
  }

  // "Unchanged" means nothing a human would notice moved — novaraSyncedAt
  // always advances, so comparing the whole payload would report every unit as
  // updated on every run and make the counts useless.
  const meaningfullyChanged =
    existing.novaraStatus !== novaraStatus ||
    !sameDay(existing.novaraExpiresOn, expiresOn) ||
    existing.novaraInService !== novaraInService ||
    data.status !== undefined;

  if (dryRun) return meaningfullyChanged ? 'updated' : 'unchanged';

  await prisma.serializedEquipment.update({ where: { id: existing.id }, data });
  return meaningfullyChanged ? 'updated' : 'unchanged';
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled processor
// ─────────────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

async function processTick(): Promise<void> {
  try {
    await syncNovaraEquipment();
  } catch (err) {
    // Persist the failure so the admin page can explain a stale lastRunAt
    // instead of just showing an old timestamp with no reason.
    const message = err instanceof Error ? err.message : String(err);
    await prisma.novaraSyncState
      .upsert({
        where: { id: 'singleton' },
        create: { id: 'singleton', lastError: message.slice(0, 2000) },
        update: { lastError: message.slice(0, 2000) },
      })
      .catch(() => undefined);
    throw err; // let runScheduledJob record it as a failed JobRun too
  }
}

export function startNovaraEquipmentSync(): void {
  if (!ENABLED) {
    console.log('[Novara] Sync skipped — NOVARA_SYNC_ENABLED=false');
    return;
  }
  if (!isConfigured()) {
    console.log('[Novara] Sync skipped — NOVARA_API_TOKEN not set');
    return;
  }
  console.log(`[Novara] Starting equipment sync (every ${Math.round(INTERVAL_MS / 60000)}m)`);
  const run = () => {
    heartbeat('novara-sync');
    // TTL generously above a full run: one call per type at ~1s spacing, so a
    // large catalog can legitimately take minutes.
    return runScheduledJob('novara.equipment-sync', 1800, processTick);
  };
  timer = setInterval(run, INTERVAL_MS);
  // Stagger the first run past boot so it isn't competing with migrations and
  // the other processors' cold start.
  setTimeout(run, 60_000);
}

export function stopNovaraEquipmentSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
