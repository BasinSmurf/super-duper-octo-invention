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

import { prisma } from '../index.js';
import { onEvent } from './eventBus.js';
import { notify, isConfigured } from './ringcentralNotify.js';
import type { RentalComposition } from './rentalComposition.js';

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

export function startRingcentralListener(): void {
  onEvent('rental.agreement.created', async (payload) => {
    if (!isConfigured('dispatch')) return;
    const equipment = summarizeEquipment(payload.composition, payload.items);
    const text =
      `🆕 **Rental job created** — ${payload.companyName}\n` +
      `${equipment}\n` +
      `Agreement #${payload.agreementNumber}`;
    await notify('dispatch', text);
  });

  onEvent('ticket.transitioned', async (payload) => {
    if (payload.toStatus !== 'dispatched') return;
    if (!isConfigured('dispatch')) return;
    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: payload.ticketId },
      select: {
        ticketNumber: true,
        ticketType: true,
        locationDisplay: true,
        fieldAreaName: true,
        company: { select: { name: true } },
      },
    });
    if (!ticket) return;
    const location = ticket.locationDisplay || ticket.fieldAreaName || 'no location set';
    const text =
      `🚚 **Field ticket dispatched** — ${ticket.company.name}\n` +
      `${humanize(ticket.ticketType)} — ${location}\n` +
      `Ticket #${ticket.ticketNumber}`;
    await notify('dispatch', text);
  });

  onEvent('shopwo.intake.created', async (payload) => {
    if (!isConfigured('intake')) return;
    const items = payload.itemCount === 1 ? '1 item' : `${payload.itemCount} items`;
    const text =
      `📥 **Shop intake** — ${payload.companyName}\n` +
      `${items} dropped off\n` +
      `Work Order #${payload.workOrderNumber}`;
    await notify('intake', text);
  });

  const active = [
    isConfigured('billing') ? 'billing' : null,
    isConfigured('dispatch') ? 'dispatch' : null,
    isConfigured('intake') ? 'intake' : null,
  ].filter(Boolean);
  console.log(
    active.length > 0
      ? `[RingCentral] notifications active for: ${active.join(', ')}`
      : '[RingCentral] no webhook URLs configured — notifications disabled',
  );
}
