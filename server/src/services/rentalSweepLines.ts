/**
 * Customer-facing rental sweep totals. Keep stored ticket rows intact for
 * billing lineage, void/reopen, and editing. Mirrored in the client/server.
 */
export interface SweepLine {
  description: string;
  partNumber?: string | null;
  product?: { partNumber?: string | null } | null;
  quantity: unknown;
  rate: unknown;
  amount: unknown;
  unitOfMeasure?: string | null;
  isTaxable?: boolean;
  qbSkip?: boolean;
  sourceTicketNumber?: string | null;
  qbItemFullName?: string | null;
}
export function rentalSweepLines<T extends SweepLine>(lines: T[]): T[] {
  const result: T[] = [];
  const groups = new Map<string, T>();
  for (const stored of lines) {
    const ticket = stored.sourceTicketNumber;
    const original = ticket ? { ...stored, sourceTicketNumber: null,
      description: stored.description.startsWith(ticket)
        ? stored.description.slice(ticket.length).replace(/^\s*[-\u2014\u2013:]\s*/, '') : stored.description } : stored;
    const part = (original.partNumber || original.product?.partNumber || original.qbItemFullName || '').split(':').pop()!.trim();
    const kind = /^(?:0[1-9]|1[01])00001$/.test(part) || part === '101' ? 'Mileage'
      : /^(?:0[1-9]|1[01])00002$/.test(part) || part === '406' ? 'Labor' : null;
    if (!kind) { result.push(original); continue; }
    // Different tax treatment must remain distinct so the invoice tax stays exact.
    const key = JSON.stringify([kind, original.isTaxable, !!original.qbSkip]);
    const existing = groups.get(key);
    if (!existing) {
      const line = { ...original, description: kind, notes: null,
        sourceTicketId: null, sourceTicketNumber: null,
        quantity: Number(original.quantity), rate: Number(original.rate), amount: Number(original.amount),
        unitOfMeasure: kind === 'Mileage' ? 'MI' : 'HR',
        useAmount: true } as T;
      groups.set(key, line);
      result.push(line);
    } else {
      const quantity = Number(existing.quantity) + Number(original.quantity);
      const amount = Math.round((Number(existing.amount) + Number(original.amount)) * 100) / 100;
      Object.assign(existing, { quantity, amount, rate: quantity ? amount / quantity : 0 });
    }
  }
  return result;
}
