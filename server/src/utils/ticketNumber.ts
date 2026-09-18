import { prisma } from '../index.js';

const PREFIXES: Record<string, string> = {
  field_service: 'FS',
  sale: 'SL',
  rental: 'RN',
  repair: 'RP',
  inspection: 'IH',
  training: 'TR',
};

/**
 * N sequential ticket numbers from ONE read of the current max.
 *
 * generateTicketNumber() reads the highest committed number, so calling it in a
 * loop inside a transaction hands out the SAME number every time — nothing it
 * created is committed yet. That collided on `ticket_number` and rolled the
 * whole batch back, which is why generating tickets for a route with more than
 * one stop always failed. Callers creating a batch must use this instead.
 */
export async function generateTicketNumbers(
  ticketType: string,
  count: number,
  serviceSubtype?: string | null,
): Promise<string[]> {
  if (count <= 0) return [];
  const first = await generateTicketNumber(ticketType, serviceSubtype);
  const [prefix, year, seq] = first.split('-');
  const start = parseInt(seq, 10);
  return Array.from({ length: count }, (_, i) =>
    `${prefix}-${year}-${String(start + i).padStart(5, '0')}`
  );
}

export async function generateTicketNumber(ticketType: string, serviceSubtype?: string | null): Promise<string> {
  // Field equipment inspections are field_service tickets (so field-ticket
  // billing/PDF logic applies) but get their own "SP-" series so they don't
  // collide with general Field Service (FS) or IH testing (IH) numbering.
  const prefix =
    ticketType === 'field_service' && serviceSubtype === 'inspection'
      ? 'SP'
      : PREFIXES[ticketType] || 'TK';
  const year = new Date().getFullYear();
  const pattern = `${prefix}-${year}-%`;

  const lastTicket = await prisma.serviceTicket.findFirst({
    where: { ticketNumber: { startsWith: `${prefix}-${year}-` } },
    orderBy: { ticketNumber: 'desc' },
    select: { ticketNumber: true },
  });

  let seq = 1;
  if (lastTicket) {
    const parts = lastTicket.ticketNumber.split('-');
    const lastSeq = parseInt(parts[2], 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
}

export async function generateRentalAgreementNumber(): Promise<string> {
  const year = new Date().getFullYear();

  const last = await prisma.rentalAgreement.findFirst({
    where: { agreementNumber: { startsWith: `RA-${year}-` } },
    orderBy: { agreementNumber: 'desc' },
    select: { agreementNumber: true },
  });

  let seq = 1;
  if (last) {
    const parts = last.agreementNumber.split('-');
    const lastSeq = parseInt(parts[2], 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `RA-${year}-${String(seq).padStart(4, '0')}`;
}

export async function generateInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();

  const last = await prisma.invoice.findFirst({
    where: { invoiceNumber: { startsWith: `INV-${year}-` } },
    orderBy: { invoiceNumber: 'desc' },
    select: { invoiceNumber: true },
  });

  let seq = 1;
  if (last) {
    const parts = last.invoiceNumber.split('-');
    const lastSeq = parseInt(parts[2], 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `INV-${year}-${String(seq).padStart(5, '0')}`;
}

export async function generateShopWorkOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();

  const last = await prisma.shopWorkOrder.findFirst({
    where: { workOrderNumber: { startsWith: `SW-${year}-` } },
    orderBy: { workOrderNumber: 'desc' },
    select: { workOrderNumber: true },
  });

  let seq = 1;
  if (last) {
    const parts = last.workOrderNumber.split('-');
    const lastSeq = parseInt(parts[2], 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `SW-${year}-${String(seq).padStart(5, '0')}`;
}
