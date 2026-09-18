/**
 * WI-10 — the contact log's pure half.
 *
 * The claim worth testing hardest is `activeFollowUp`: a job is judged by its
 * NEWEST commitment, not its oldest. Get that backwards and the widget shows
 * jobs somebody already chased this morning, which is how a follow-up list
 * stops being read.
 */

import { describe, it, expect } from 'vitest';
import {
  CONTACT_METHODS,
  CONTACT_PARTIES,
  activeFollowUp,
  describeOverdue,
  isContactMethod,
  isContactParty,
  isFollowUpDue,
  parseContactEntry,
} from './shopContactLog.js';

const NOW = new Date('2026-08-31T12:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('vocabulary guards', () => {
  it('accepts exactly the two parties', () => {
    expect(CONTACT_PARTIES).toEqual(['customer', 'vendor']);
    expect(isContactParty('vendor')).toBe(true);
    expect(isContactParty('supplier')).toBe(false);
    expect(isContactParty(undefined)).toBe(false);
  });

  it('keeps the original five methods', () => {
    // The old JSONB log validated against exactly this list. Narrowing it here
    // would fail to migrate historical entries.
    expect(CONTACT_METHODS).toEqual(['call', 'email', 'text', 'in_person', 'other']);
    expect(isContactMethod('in_person')).toBe(true);
    expect(isContactMethod('carrier_pigeon')).toBe(false);
  });
});

describe('parseContactEntry', () => {
  const base = { party: 'vendor', method: 'call', note: 'Called DFE, ETA 9/1' };

  it('accepts a well-formed entry', () => {
    const r = parseContactEntry(base, NOW);
    expect(r.ok).toBe(true);
    expect(r.value!.party).toBe('vendor');
    expect(r.value!.followUpAt).toBeNull();
  });

  it('defaults contactedAt to now rather than refusing', () => {
    // "When did you call?" is almost always "just now". Making it required
    // would add a field to every entry to serve the rare backfill.
    const r = parseContactEntry(base, NOW);
    expect(r.value!.contactedAt).toEqual(NOW);
  });

  it('requires a note — the sentence IS the entry', () => {
    expect(parseContactEntry({ ...base, note: '   ' }, NOW).ok).toBe(false);
    expect(parseContactEntry({ ...base, note: undefined }, NOW).ok).toBe(false);
  });

  it('rejects an unknown party or method', () => {
    expect(parseContactEntry({ ...base, party: 'supplier' }, NOW).ok).toBe(false);
    expect(parseContactEntry({ ...base, method: 'smoke_signal' }, NOW).ok).toBe(false);
  });

  it('refuses a contact logged in the future', () => {
    const r = parseContactEntry({ ...base, contactedAt: day(2).toISOString() }, NOW);
    expect(r.ok).toBe(false);
  });

  it('tolerates a minute of clock skew on contactedAt', () => {
    // A device thirty seconds fast should not be told it is lying.
    const r = parseContactEntry(
      { ...base, contactedAt: new Date(NOW.getTime() + 30_000).toISOString() },
      NOW,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a follow-up date and keeps it', () => {
    const r = parseContactEntry({ ...base, followUpAt: day(1).toISOString() }, NOW);
    expect(r.value!.followUpAt).toEqual(day(1));
  });

  it('treats an empty follow-up as absent, not as invalid', () => {
    for (const v of ['', null, undefined]) {
      const r = parseContactEntry({ ...base, followUpAt: v }, NOW);
      expect(r.ok).toBe(true);
      expect(r.value!.followUpAt).toBeNull();
    }
  });

  it('rejects an unparseable follow-up date', () => {
    expect(parseContactEntry({ ...base, followUpAt: 'next tuesday-ish' }, NOW).ok).toBe(false);
  });

  it('catches a mistyped year rather than parking the job for a century', () => {
    // 2206 for 2026. Without this the entry lands in "not due yet" forever,
    // which is indistinguishable from having no follow-up at all.
    const r = parseContactEntry({ ...base, followUpAt: '2206-09-01T00:00:00Z' }, NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/typo/i);
  });

  it('allows a follow-up in the past — chasing something already overdue', () => {
    const r = parseContactEntry({ ...base, followUpAt: day(-3).toISOString() }, NOW);
    expect(r.ok).toBe(true);
  });

  it('caps note length rather than letting a paste blow up the column', () => {
    const r = parseContactEntry({ ...base, note: 'x'.repeat(5000) }, NOW);
    expect(r.value!.note.length).toBe(2000);
  });
});

describe('activeFollowUp', () => {
  const entry = (contactedAt: Date, followUpAt: Date | null, deletedAt: Date | null = null) =>
    ({ contactedAt, followUpAt, deletedAt });

  it('returns null when nothing carries a follow-up', () => {
    expect(activeFollowUp([entry(day(-5), null), entry(day(-2), null)])).toBeNull();
  });

  it('takes the NEWEST commitment, not the oldest', () => {
    // The load-bearing case. A second call that moved the ETA out supersedes
    // the first; showing the stale one puts an already-chased job in the
    // overdue pile.
    const stale = entry(day(-5), day(-1));
    const fresh = entry(day(-1), day(3));
    expect(activeFollowUp([stale, fresh])).toBe(fresh);
    expect(activeFollowUp([fresh, stale])).toBe(fresh);
  });

  it('ignores entries with no follow-up when picking the newest', () => {
    // A later note with no ETA does not clear an earlier commitment — it just
    // did not make one.
    const withEta = entry(day(-5), day(1));
    const laterNoEta = entry(day(-1), null);
    expect(activeFollowUp([withEta, laterNoEta])).toBe(withEta);
  });

  it('ignores deleted entries — a retracted call holds no commitment', () => {
    const deleted = entry(day(-1), day(9), day(0));
    const live = entry(day(-5), day(1));
    expect(activeFollowUp([deleted, live])).toBe(live);
  });

  it('returns null when every commitment was deleted', () => {
    expect(activeFollowUp([entry(day(-1), day(9), day(0))])).toBeNull();
  });
});

describe('the ordering trap: reduce THEN filter, never the other way', () => {
  // This is a regression test for a bug the helper's own tests could not catch,
  // because the mistake was made by the CALLER.
  //
  // The follow-ups widget originally asked the database for "entries whose
  // follow-up has passed" and then picked the newest of those. That looks
  // right and is wrong: a job whose vendor promised NEXT Friday an hour ago has
  // that entry excluded by the date filter, so the newest thing the query can
  // see is the stale overdue one — and the job sits in the overdue list having
  // just been chased.
  //
  // The rule is: reduce to the current commitment across ALL live entries, then
  // apply the horizon to what survives.
  const entries = [
    { contactedAt: day(-6), followUpAt: day(-2), deletedAt: null }, // stale, overdue
    { contactedAt: day(0), followUpAt: day(7), deletedAt: null },   // fresh promise
  ];

  it('drops the job once a newer promise supersedes the overdue one', () => {
    const current = activeFollowUp(entries)!;
    expect(current.followUpAt).toEqual(day(7));
    expect(isFollowUpDue(current.followUpAt, NOW)).toBe(false);
  });

  it('shows the WRONG answer if the horizon is applied first', () => {
    // Kept as an executable description of the bug, so the mistake is not
    // re-introduced by someone "optimising" the query.
    const preFiltered = entries.filter((e) => e.followUpAt!.getTime() <= NOW.getTime());
    const wrong = activeFollowUp(preFiltered)!;
    expect(wrong.followUpAt).toEqual(day(-2));
    expect(isFollowUpDue(wrong.followUpAt, NOW)).toBe(true); // the job we already chased
  });
});

describe('isFollowUpDue / describeOverdue', () => {
  it('is due once the moment has passed', () => {
    expect(isFollowUpDue(day(-1), NOW)).toBe(true);
    expect(isFollowUpDue(day(1), NOW)).toBe(false);
    expect(isFollowUpDue(null, NOW)).toBe(false);
  });

  it('counts the exact moment as due, not as pending', () => {
    expect(isFollowUpDue(NOW, NOW)).toBe(true);
  });

  it('describes overdue in whole days', () => {
    expect(describeOverdue(NOW, NOW)).toBe('due today');
    expect(describeOverdue(day(-1), NOW)).toBe('1 day overdue');
    expect(describeOverdue(day(-4), NOW)).toBe('4 days overdue');
    expect(describeOverdue(day(3), NOW)).toBe('not due yet');
  });
});
