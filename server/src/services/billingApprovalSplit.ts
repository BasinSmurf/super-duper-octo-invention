import { createHash } from 'node:crypto';
import { AppError } from '../middleware/errorHandler.js';
import { ihWorkTypes, profileForBillingWork, type BillingWork } from './billingApprovalGroups.js';
import type { SelectableProfile } from './billingProfileSelector.js';

type Profile = SelectableProfile & { notes?: string | null };
type Line = Record<string, any> & { lineNumber: number; description: string; quantity: number; rate: number; amount: number; isTaxable: boolean };
type Ticket = BillingWork & { id: string; ticketNumber?: string; updatedAt?: Date; approvalProfileIds?: string[] };
export interface ApprovalAllocation { key: string; parts: { profileId: string; quantity: number }[] }

const groupId = (profile: Profile | null) => profile?.id || 'default';
export function billingApprovalPlan(profiles: Profile[], tickets: Ticket[], lines: Line[]) {
  const groups = new Map<string, { id: string; label: string }>();
  const choices = new Map<string, string[]>();
  for (const ticket of tickets) {
    const addGroup = (profile: Profile | null) => {
      const id = groupId(profile);
      groups.set(id, { id, label: Array.isArray(profile?.appliesToTicketTypes) && profile.appliesToTicketTypes.includes('ih_sampling')
        ? 'IH → Sampling' : profile?.notes || 'General billing' });
      return id;
    };
    const types = ihWorkTypes(ticket);
    const destinations = ticket.approvalProfileIds
      ? ticket.approvalProfileIds.map(id => {
        const profile = profiles.find(profile => profile.id === id);
        if (id !== 'default' && !profile) throw new AppError(409, 'An approved billing group is no longer available');
        return addGroup(profile || null);
      })
      : (types.length ? types : [ticket.serviceSubtype]).map(serviceSubtype =>
        addGroup(profileForBillingWork(profiles, { ...ticket, serviceSubtype, customData: null, ihTestRecords: [] })));
    choices.set(ticket.id, [...new Set(destinations)].sort());
  }
  const all = [...groups.keys()];
  const rows = lines.map(line => {
    const allowed = choices.get(line.sourceTicketId) || all;
    return { key: line.sourceTicketLineItemId || `generated:${line.sourceTicketId || 'invoice'}:${line.lineNumber}`,
      ticketNumber: line.sourceTicketNumber || '', description: line.description as string,
      unitOfMeasure: String(line.unitOfMeasure || 'EA'), quantity: Number(line.quantity), rate: Number(line.rate), amount: Number(line.amount),
      profileIds: allowed, defaultProfileId: allowed.length === 1 ? allowed[0] : null };
  });
  const version = createHash('sha256').update(JSON.stringify({ rows, tickets: tickets.map(t => [t.id, t.updatedAt]), groups: [...groups.keys()].sort() })).digest('hex');
  return { version, groups: [...groups.values()], rows, requiresReview: rows.some(row => !row.defaultProfileId) };
}

/** Partition every charge exactly once, conserving quantity and original cents. */
export function splitBillingApprovals(profiles: Profile[], tickets: Ticket[], lines: Line[], allocations?: ApprovalAllocation[], expectedVersion?: string) {
  const plan = billingApprovalPlan(profiles, tickets, lines);
  if (allocations !== undefined && !Array.isArray(allocations)) throw new AppError(400, 'Approval allocations must be an array');
  if (allocations && expectedVersion !== plan.version) throw new AppError(409, 'The billing charges changed. Refresh the allocation before approving.');
  const requested = new Map<string, ApprovalAllocation>();
  for (const allocation of allocations || []) {
    if (!allocation || typeof allocation.key !== 'string' || requested.has(allocation.key) ||
        !plan.rows.some(row => row.key === allocation.key) || !Array.isArray(allocation.parts)) {
      throw new AppError(400, 'Invalid or duplicate approval allocation');
    }
    requested.set(allocation.key, allocation);
  }
  const result = new Map<string, { billingProfileId: string | null; lines: Line[] }>();
  for (const [index, row] of plan.rows.entries()) {
    const parts = requested.get(row.key)?.parts || (row.defaultProfileId ? [{ profileId: row.defaultProfileId, quantity: row.quantity }] : []);
    if (!parts.length) throw new AppError(400, 'Assign shared charges to approval groups during ticket approval before generating invoices.');
    const quantityUnits = (value: number) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001)
        throw new AppError(400, 'Approval quantities must be nonnegative numbers with at most two decimals');
      const units = Math.round(value * 100);
      if (!Number.isSafeInteger(units)) throw new AppError(400, 'Approval quantity is too large');
      return units;
    };
    const totalUnits = quantityUnits(row.quantity);
    const seen = new Set<string>();
    const units = parts.map(part => {
      if (!part || !row.profileIds.includes(part.profileId) || seen.has(part.profileId)) throw new AppError(400, 'Invalid approval group for this charge');
      seen.add(part.profileId);
      const value = quantityUnits(part.quantity);
      if (!value && totalUnits) throw new AppError(400, 'Each allocated charge quantity must be greater than zero');
      return value;
    });
    if (units.reduce((sum, value) => sum + value, 0) !== totalUnits || (!totalUnits && parts.length !== 1))
      throw new AppError(400, `Allocate the full quantity for ${row.description}; charges cannot be omitted or billed twice.`);
    const totalCents = Math.round(row.amount * 100);
    const shares = units.map(value => totalUnits ? Math.abs(totalCents) * value / totalUnits : Math.abs(totalCents));
    const centsByPart = shares.map(Math.floor);
    const remainder = Math.abs(totalCents) - centsByPart.reduce((sum, cents) => sum + cents, 0);
    const order = shares.map((value, i) => ({ i, fraction: value - centsByPart[i] }))
      .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
    for (let i = 0; i < remainder; i++) centsByPart[order[i].i]++;
    parts.forEach((part, partIndex) => {
      const cents = centsByPart[partIndex] * Math.sign(totalCents);
      const destination = result.get(part.profileId) || { billingProfileId: part.profileId === 'default' ? null : part.profileId, lines: [] };
      destination.lines.push({ ...lines[index], quantity: part.quantity, amount: cents / 100,
        lineNumber: destination.lines.length + 1, sortOrder: destination.lines.length });
      result.set(part.profileId, destination);
    });
  }
  return [...result.values()];
}
