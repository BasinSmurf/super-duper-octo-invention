import { prisma, Prisma } from '../db.js';

const PREFIXES: Record<string, string> = {
  field_service: 'FS', sale: 'SL', rental: 'RN', repair: 'RP', inspection: 'IH', training: 'TR',
};
const SOURCES = {
  ticket: { table: 'service_tickets', column: 'ticket_number' },
  rental: { table: 'rental_agreements', column: 'agreement_number' },
  invoice: { table: 'invoices', column: 'invoice_number' },
  shop: { table: 'shop_work_orders', column: 'work_order_number' },
} as const;

/** Reserve atomically across API processes. Catch up against existing documents
 * so imports cannot rewind numbering. A later create failure leaves a gap.
 */
async function reserveNumbers(source: keyof typeof SOURCES, prefix: string, count: number, width = 5): Promise<string[]> {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Number count must be a non-negative integer');
  if (count === 0) return [];
  const namespace = `${prefix}-${new Date().getFullYear()}`;
  const { table, column } = SOURCES[source];
  // Identifiers are constants above, never caller input. All values are bound.
  const rows = await prisma.$queryRaw<Array<{ lastValue: number }>>(Prisma.sql`
    WITH existing AS (
      SELECT COALESCE(MAX(CAST(substring(${Prisma.raw(column)} FROM ${`^${namespace}-([0-9]+)$`}) AS INTEGER)), 0) AS maximum
      FROM ${Prisma.raw(table)} WHERE ${Prisma.raw(column)} LIKE ${`${namespace}-%`}
    )
    INSERT INTO document_number_counters (namespace, last_value)
    SELECT ${namespace}, maximum + ${count} FROM existing
    ON CONFLICT (namespace) DO UPDATE
    SET last_value = GREATEST(document_number_counters.last_value, (SELECT maximum FROM existing)) + ${count}
    RETURNING last_value AS "lastValue"
  `);
  const first = rows[0].lastValue - count + 1;
  return Array.from({ length: count }, (_, i) => `${namespace}-${String(first + i).padStart(width, '0')}`);
}
export async function generateTicketNumbers(ticketType: string, count: number, serviceSubtype?: string | null): Promise<string[]> {
  const prefix = ticketType === 'field_service' && serviceSubtype === 'inspection' ? 'SP' : PREFIXES[ticketType] || 'TK';
  return reserveNumbers('ticket', prefix, count);
}
export async function generateTicketNumber(ticketType: string, serviceSubtype?: string | null): Promise<string> {
  return (await generateTicketNumbers(ticketType, 1, serviceSubtype))[0];
}
export async function generateRentalAgreementNumber(): Promise<string> {
  return (await reserveNumbers('rental', 'RA', 1, 4))[0];
}
export async function generateInvoiceNumber(): Promise<string> {
  return (await reserveNumbers('invoice', 'INV', 1))[0];
}
export async function generateShopWorkOrderNumber(): Promise<string> {
  return (await reserveNumbers('shop', 'SW', 1))[0];
}
