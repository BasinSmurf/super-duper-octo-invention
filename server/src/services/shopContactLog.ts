/**
 * shopContactLog.ts — WI-10: one place to record "called DFE, ETA 9/1".
 *
 * WHAT THE SPEC GOT WRONG, AND WHY IT MATTERS
 *
 * WI-10 said to "generalize the existing customer call log component and
 * table". There was no table. The log was a `contactLog` JSONB array on
 * ShopWorkOrder, and it was never scoped to Ready For Pickup either — only the
 * CARD was, by a `status === 'complete'` check in the page. So this is a BUILD,
 * not a generalize, and the JSON is migrated in.
 *
 * That distinction changed the design rather than just the effort. A JSONB
 * array hanging off each work order can answer "what did we say to this
 * customer", and it fundamentally cannot answer "whose ETA has passed" —
 * which is the follow-up widget's only question. A log you can read one job at
 * a time is a log nobody plans a day from.
 *
 * APPEND-ONLY, AND THE DELETE THAT ISN'T ONE
 *
 * The spec asks for both "append-only" and "supervisors may delete an entry
 * with a logged reason", which sound contradictory and are not. A hard delete
 * that records its reason somewhere else keeps the reason and throws away the
 * evidence — the one thing anybody looking at the audit trail actually wants.
 * So a delete here is SOFT: the row stays, marked with who removed it and why,
 * and the default read hides it.
 *
 * Neither the append-only rule nor the reason requirement is enforced here.
 * They are in the database (a BEFORE UPDATE trigger and a CHECK constraint, see
 * the 20260831190000 migration), because this module is not the only writer and
 * a rule that lives in one route is a rule the next route does not have.
 */

import type { ContactMethod, ContactParty } from '../db.js';

export const CONTACT_PARTIES: ContactParty[] = ['customer', 'vendor'];
export const CONTACT_METHODS: ContactMethod[] = ['call', 'email', 'text', 'in_person', 'other'];

export const PARTY_LABEL: Record<ContactParty, string> = {
  customer: 'Communicated to Customer',
  vendor: 'Communicated with Vendor',
};

export const METHOD_LABEL: Record<ContactMethod, string> = {
  call: 'Called',
  email: 'Emailed',
  text: 'Texted',
  in_person: 'In person',
  other: 'Other',
};

export function isContactParty(v: unknown): v is ContactParty {
  return typeof v === 'string' && (CONTACT_PARTIES as string[]).includes(v);
}

export function isContactMethod(v: unknown): v is ContactMethod {
  return typeof v === 'string' && (CONTACT_METHODS as string[]).includes(v);
}

export interface ContactEntryInput {
  party: ContactParty;
  method: ContactMethod;
  note: string;
  contactedAt: Date;
  followUpAt: Date | null;
}

export interface ParseResult {
  ok: boolean;
  error?: string;
  value?: ContactEntryInput;
}

/** How far ahead a follow-up may be set. A typo of 2206 for 2026 is otherwise
 *  a row that sits in the widget's "not due yet" pile for a hundred and eighty
 *  years, which is to say invisibly. */
const MAX_FOLLOW_UP_DAYS = 365;

export function parseContactEntry(body: unknown, now: Date = new Date()): ParseResult {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  if (!isContactParty(src.party)) {
    return { ok: false, error: `party must be one of: ${CONTACT_PARTIES.join(', ')}` };
  }
  if (!isContactMethod(src.method)) {
    return { ok: false, error: `method must be one of: ${CONTACT_METHODS.join(', ')}` };
  }

  const note = typeof src.note === 'string' ? src.note.trim() : '';
  if (!note) {
    // An entry with no note records that somebody touched a button. The whole
    // value of this log is the sentence.
    return { ok: false, error: 'A note is required — what was said is the point of the entry.' };
  }

  const contactedAt = parseDate(src.contactedAt) ?? now;
  if (contactedAt.getTime() > now.getTime() + 60_000) {
    return { ok: false, error: 'A contact cannot be logged in the future.' };
  }

  let followUpAt: Date | null = null;
  if (src.followUpAt !== undefined && src.followUpAt !== null && src.followUpAt !== '') {
    const d = parseDate(src.followUpAt);
    if (!d) return { ok: false, error: 'The follow-up date is not a valid date.' };
    const maxAhead = now.getTime() + MAX_FOLLOW_UP_DAYS * 86_400_000;
    if (d.getTime() > maxAhead) {
      return {
        ok: false,
        error: `A follow-up more than ${MAX_FOLLOW_UP_DAYS} days out is almost certainly a typo in the year.`,
      };
    }
    followUpAt = d;
  }

  return { ok: true, value: { party: src.party, method: src.method, note: note.slice(0, 2000), contactedAt, followUpAt } };
}

function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Which entry, if any, is the live follow-up commitment for a work order.
 *
 * THE LATEST ONE WINS, not the earliest. Somebody who rings the vendor again
 * and gets a new ETA has superseded the old one; showing the stale date would
 * put a job in the overdue list that a person has already chased today, which
 * is precisely how a follow-up list stops being believed.
 *
 * Deleted entries are excluded — a retracted call cannot hold a commitment.
 */
export function activeFollowUp<T extends { followUpAt: Date | null; contactedAt: Date; deletedAt: Date | null }>(
  entries: T[],
): T | null {
  const live = entries.filter((e) => !e.deletedAt && e.followUpAt);
  if (live.length === 0) return null;
  return live.reduce((a, b) => (b.contactedAt.getTime() > a.contactedAt.getTime() ? b : a));
}

/** Is this work order's follow-up commitment overdue? */
export function isFollowUpDue(followUpAt: Date | null, now: Date = new Date()): boolean {
  return !!followUpAt && followUpAt.getTime() <= now.getTime();
}

/** "3 days overdue" / "due today" — coarse on purpose. */
export function describeOverdue(followUpAt: Date, now: Date = new Date()): string {
  const ms = now.getTime() - followUpAt.getTime();
  if (ms < 0) return 'not due yet';
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return 'due today';
  return `${days} day${days === 1 ? '' : 's'} overdue`;
}
