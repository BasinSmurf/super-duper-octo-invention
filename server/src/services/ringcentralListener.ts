/**
 * ringcentralListener.ts
 *
 * Bridges the event bus to RingCentral Team Messaging: a rental job, a
 * ticket dispatch, or a shop intake creates a chat post automatically, so
 * field/dispatch no longer has to remember to also type it into RingCentral
 * by hand.
 *
 * Each event's channel is independently gated by ringcentralNotify.isConfigured
 * — an unconfigured channel just means that event's handler no-ops.
 */

import { prisma } from '../db.js';
import { onEvent } from './eventBus.js';
import { notify, isConfigured } from './ringcentralNotify.js';
import type { RentalComposition } from './rentalComposition.js';
import { humanizeCategory } from './shopBoard.js';

/**
 * "What equipment does this job need" — one line, for a "get it ready"
 * heads-up. Real assigned items (walk-ins) win when present; otherwise this
 * is the only equipment info that exists yet, since dispatch-time agreements
 * carry a spec (composition), not real serialized equipment.
 */
function summarizeEquipment(
  composition: RentalComposition | null,
  items: { productName: string }[],
): string {
  if (items.length > 0) {
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item.productName, (counts.get(item.productName) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, qty]) => `${qty}× ${name}`)
      .join(', ');
  }

  if (!composition) return 'no equipment specified yet';

  const parts: string[] = [];
  if (composition.trailer) {
    parts.push(`${composition.trailer.manned ? 'manned' : 'unmanned'} trailer`);
  }
  for (const g of composition.gasMonitors ?? []) {
    parts.push(`${g.qty ?? 1}× ${g.productName || 'gas monitor'}`);
  }
  for (const o of composition.other ?? []) {
    parts.push(`${o.qty ?? 1}× ${o.label}`);
  }
  if (composition.drillingRig) parts.push('drilling rig');

  return parts.length > 0 ? parts.join(' + ') : 'no equipment specified yet';
}

/** 'field_super_review' -> 'Field Super Review', 'fit_test' -> 'Fit Test'. */
function humanize(value: string): string {
  return value
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const locationRelations = {
  field: { select: { name: true } },
  pad: { select: { name: true } },
  well: { select: { wellName: true } },
  facility: { select: { name: true } },
} as const;

async function locationText(record: {
  field?: { name: string } | null;
  pad?: { name: string } | null;
  well?: { wellName: string | null } | null;
  facility?: { name: string } | null;
  workPoint?: { name: string } | null;
  locationDisplay?: string | null;
  fieldAreaName?: string | null;
}, wellIds: unknown): Promise<string> {
  const ids = Array.isArray(wellIds) ? [...new Set(wellIds.filter((id): id is string => typeof id === 'string' && !!id))] : [];
  const wells = ids.length ? await prisma.well.findMany({ where: { id: { in: ids } }, select: { id: true, wellName: true } }) : [];
  const names = [...new Set([record.well?.wellName, ...ids.map(id => wells.find(well => well.id === id)?.wellName)].filter(Boolean))];
  const parts = [record.field?.name, record.pad?.name, record.facility?.name, ...names, record.workPoint?.name].filter(Boolean);
  return [...new Set(parts)].join(' > ') || record.locationDisplay || record.fieldAreaName || 'no location set';
}

function recordLink(kind: 'tickets' | 'rentals', id: string, label: string): string {
  const base = (process.env.PUBLIC_APP_URL || 'https://service.basinsafetyus.com').replace(/\/+$/, '');
  return `[${label}](${base}/${kind}/${encodeURIComponent(id)})`;
}

export function startRingcentralListener(): void {
  onEvent('rental.agreement.created', async (payload) => {
    const channel = 'rentals';
    if (!await isConfigured(channel)) return;
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id: payload.agreementId },
      select: { ...locationRelations, wellIds: true, startDate: true },
    });
    const location = agreement ? await locationText(agreement, agreement.wellIds) : 'no location set';
    const equipment = summarizeEquipment(payload.composition, payload.items);
    // startDate is a DATE column (UTC midnight) — format in UTC or it reads a day early.
    const start = agreement?.startDate
      ? agreement.startDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      : 'not set';
    const text =
      `🆕 **Rental job created** — ${payload.companyName}\n` +
      `Location: ${location}\n` +
      `Start: ${start}\n` +
      `${equipment}\n` +
      recordLink('rentals', payload.agreementId, `Agreement #${payload.agreementNumber}`);
    await notify(channel, text);
  });

  onEvent('ticket.transitioned', async (payload) => {
    if (payload.toStatus !== 'dispatched') return;
    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: payload.ticketId },
      select: {
        ticketNumber: true,
        ticketType: true,
        locationDisplay: true,
        fieldAreaName: true,
        division: true,
        customData: true,
        ...locationRelations,
        workPoint: { select: { name: true } },
        company: { select: { name: true } },
      },
    });
    if (!ticket) return;
    const data = ticket.customData as { dispatchNotificationDivision?: string; wellIds?: unknown } | null;
    const division = data?.dispatchNotificationDivision === 'D3' || data?.dispatchNotificationDivision === 'D4'
      ? data.dispatchNotificationDivision : ticket.division === 'D3' ? 'D3' : 'D4';
    const channel = division === 'D3' ? 'dispatch_d3' : 'dispatch';
    if (!await isConfigured(channel)) return;
    const location = await locationText(ticket, data?.wellIds);
    const text =
      `🚚 **Field ticket dispatched** — ${ticket.company.name}\n` +
      `${division} · ${humanize(ticket.ticketType)}\n` +
      `Location: ${location}\n` +
      recordLink('tickets', payload.ticketId, `Ticket #${ticket.ticketNumber}`);
    await notify(channel, text);
  });

  onEvent('shopwo.intake.created', async (payload) => {
    if (!await isConfigured('intake')) return;
    const items = payload.itemCount === 1 ? '1 item' : `${payload.itemCount} items`;
    // "3 × SCBA, 2 × Fire Extinguisher" — biggest group first. Falls back to
    // the bare item count when the emitter sent no breakdown.
    const breakdown = [...(payload.categoryCounts ?? [])]
      .sort((a, b) => b.count - a.count)
      .map(c => `${c.count} × ${humanizeCategory(c.category)}`)
      .join(', ');
    const text =
      (payload.priority === 1 ? `🚨 **!! URGENT !!** 🚨\n` : '') +
      `📥 **Shop intake** — ${payload.companyName}\n` +
      (breakdown ? `Dropped off: ${breakdown}\n` : `${items} dropped off\n`) +
      `Work Order #${payload.workOrderNumber}`;
    await notify('intake', text);
  });

  console.log('[RingCentral] notification listener started; destinations managed in Settings');
}
