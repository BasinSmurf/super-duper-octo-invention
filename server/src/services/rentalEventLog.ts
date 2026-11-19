import { Prisma } from '../db.js';

/** Append a visit without changing its billing disposition. Caller holds the rental lock. */
export async function appendRentalEventLog(tx: Prisma.TransactionClient, ticket: {
  id: string; ticketNumber: string | null; linkedRentalAgreementId: string | null;
  serviceDate: Date; arrivalTime?: Date | string | null; workDescription?: string | null; assignedTechId?: string | null; createdById?: string | null;
}) {
  const loggedById = ticket.assignedTechId || ticket.createdById;
  if (!ticket.linkedRentalAgreementId || !loggedById) return;
  const logDate = new Date(ticket.serviceDate);
  logDate.setUTCHours(0, 0, 0, 0);
  const existing = await tx.rentalDailyLog.findFirst({ where: { rentalAgreementId: ticket.linkedRentalAgreementId, logDate } });
  const prior = Array.isArray(existing?.entries) ? existing.entries as any[] : [];
  if (prior.some(entry => entry.ticketId === ticket.id || entry.text?.includes(`Service ticket ${ticket.ticketNumber}`))) return;
  const now = new Date();
  const entry = { id: ticket.id, ticketId: ticket.id, date: logDate.toISOString().slice(0, 10), time: ticket.arrivalTime ? (typeof ticket.arrivalTime === 'string' && /^\d{2}:\d{2}/.test(ticket.arrivalTime) ? ticket.arrivalTime.slice(0, 5) : new Date(ticket.arrivalTime).toISOString().slice(11, 16)) : '', type: 'note',
    text: `Service ticket ${ticket.ticketNumber} — ${ticket.workDescription || 'Equipment visit'}`, createdAt: now.toISOString() };
  if (existing) await tx.rentalDailyLog.update({ where: { id: existing.id }, data: { entries: [...prior, entry] } });
  else await tx.rentalDailyLog.create({ data: { rentalAgreementId: ticket.linkedRentalAgreementId, logDate, loggedById,
    equipmentPresent: true, equipmentStatus: 'operational', entries: [entry] } });
}
