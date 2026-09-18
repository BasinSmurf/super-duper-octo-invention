/**
 * gcalSync.ts — push ClassPRO scheduled sessions to Google Calendar.
 *
 * One event per session on a shared "Training" calendar; the assigned
 * trainer is invited as an attendee, so the class also lands on their own
 * Workspace calendar and reschedules/cancellations update automatically
 * (sendUpdates: 'all').
 *
 * Auth rides the same service-account + domain-wide-delegation setup as
 * googleGroups.ts (GOOGLE_SA_KEY_PATH), impersonating an organizer. Setup:
 *   1. Enable "Google Calendar API" in the GCP project
 *   2. Add scope https://www.googleapis.com/auth/calendar.events to the
 *      service account's domain-wide delegation entry (admin.google.com →
 *      Security → API Controls → Domain-wide Delegation — scopes are
 *      exact-match, so this is IN ADDITION to the directory scopes)
 *   3. Create/pick the shared Training calendar; put its calendar id in
 *      CLASSPRO_GCAL_CALENDAR_ID (the organizer must have edit rights)
 *   4. Optionally set CLASSPRO_GCAL_ORGANIZER (defaults to
 *      GOOGLE_ADMIN_EMAIL) — the Workspace user events are created as
 *
 * Bad-divorce: everything here is best-effort. Missing config or a Google
 * outage logs a warning and scheduling proceeds; the next save retries.
 * Sync happens only on save/cancel — never on calendar render.
 */

import { google } from 'googleapis';
import { prisma } from '../index.js';

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TZ = 'America/Chicago';

function calendarId(): string {
  return process.env.CLASSPRO_GCAL_CALENDAR_ID || '';
}
function organizer(): string {
  return process.env.CLASSPRO_GCAL_ORGANIZER || process.env.GOOGLE_ADMIN_EMAIL || '';
}

export function gcalConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SA_KEY_PATH && calendarId() && organizer());
}

/** One-line startup status so "is gcal on?" is answerable from the boot log. */
export function logGcalStatus(): void {
  if (gcalConfigured()) {
    console.log(`[gcalSync] Enabled — calendar ${calendarId()}, organizer ${organizer()}`);
    return;
  }
  const missing = [
    !process.env.GOOGLE_SA_KEY_PATH && 'GOOGLE_SA_KEY_PATH',
    !calendarId() && 'CLASSPRO_GCAL_CALENDAR_ID',
    !organizer() && 'CLASSPRO_GCAL_ORGANIZER/GOOGLE_ADMIN_EMAIL',
  ].filter(Boolean).join(', ');
  console.log(`[gcalSync] Skipped — not configured (missing: ${missing})`);
}

let _calendar: ReturnType<typeof google.calendar> | null = null;

async function getCalendar() {
  if (_calendar) return _calendar;
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SA_KEY_PATH,
    scopes: [CAL_SCOPE],
    clientOptions: { subject: organizer() },
  });
  const client = await auth.getClient();
  _calendar = google.calendar({ version: 'v3', auth: client as never });
  return _calendar;
}

type SessionWithRefs = NonNullable<Awaited<ReturnType<typeof loadSession>>>;

function loadSession(sessionId: string) {
  return prisma.cpScheduledSession.findUnique({
    where: { id: sessionId },
    include: {
      course: { select: { name: true } },
      trainer: { select: { user: { select: { name: true, email: true } } } },
      location: { select: { name: true, address: true, city: true, state: true } },
    },
  });
}

function eventLocation(s: SessionWithRefs): string {
  if (s.location) {
    return [s.location.name, s.location.address, s.location.city, s.location.state].filter(Boolean).join(', ');
  }
  if (s.adHocAddress) return s.adHocAddress;
  return 'Basin Safety (in-house)';
}

function eventBody(s: SessionWithRefs) {
  const ymd = s.date.toISOString().slice(0, 10);
  const descLines = [
    s.trainer ? `Trainer: ${s.trainer.user.name}` : 'Trainer: unassigned',
    s.deliveryMode === 'on_site' ? 'On-site class' : 'In-house class',
    s.capacity != null ? `Capacity: ${s.capacity}` : null,
    s.travelBeforeMin || s.travelAfterMin ? `Travel: ${s.travelBeforeMin} min out / ${s.travelAfterMin} min back` : null,
    s.notes,
    '— Scheduled in Sundog (Training → Calendar)',
  ].filter(Boolean);

  return {
    summary: `Training: ${s.course.name}`,
    location: eventLocation(s),
    description: descLines.join('\n'),
    start: { dateTime: `${ymd}T${s.startTime}:00`, timeZone: TZ },
    end: { dateTime: `${ymd}T${s.endTime}:00`, timeZone: TZ },
    attendees: s.trainer?.user.email ? [{ email: s.trainer.user.email }] : [],
    extendedProperties: { private: { sundogSessionId: s.id } },
  };
}

function isGone(err: unknown): boolean {
  const code = (err as { code?: number | string }).code;
  return code === 404 || code === 410 || code === '404' || code === '410';
}

/**
 * Push a session to Google Calendar (insert or patch by stored event id).
 * Cancelled sessions are removed instead. Never throws.
 */
export async function syncSessionToGcal(sessionId: string): Promise<void> {
  if (!gcalConfigured()) return;
  try {
    const s = await loadSession(sessionId);
    if (!s) return;

    if (s.status === 'cancelled') {
      await removeSessionFromGcal(s.id, s.gcalEventId);
      return;
    }

    const cal = await getCalendar();
    const body = eventBody(s);

    if (s.gcalEventId) {
      try {
        await cal.events.patch({
          calendarId: calendarId(),
          eventId: s.gcalEventId,
          requestBody: body,
          sendUpdates: 'all',
        });
        console.log(`[gcalSync] session ${s.id} → updated event ${s.gcalEventId}`);
        return;
      } catch (err) {
        // Someone deleted the event in gcal — fall through and recreate.
        if (!isGone(err)) throw err;
      }
    }

    const res = await cal.events.insert({
      calendarId: calendarId(),
      requestBody: body,
      sendUpdates: 'all',
    });
    if (res.data.id) {
      await prisma.cpScheduledSession.update({
        where: { id: s.id },
        data: { gcalEventId: res.data.id },
      });
      const invited = s.trainer?.user.email ? ` (invited ${s.trainer.user.email})` : '';
      console.log(`[gcalSync] session ${s.id} → created event ${res.data.id}${invited}`);
    }
  } catch (err) {
    // Auth misconfig should surface fresh on the next attempt.
    if ((err as Error).message?.includes('unauthorized_client')) _calendar = null;
    console.warn(`[gcalSync] session ${sessionId} sync failed:`, err instanceof Error ? err.message : err);
  }
}

/** Delete the session's gcal event (attendees get a cancellation). Never throws. */
export async function removeSessionFromGcal(sessionId: string, gcalEventId: string | null): Promise<void> {
  if (!gcalConfigured() || !gcalEventId) return;
  try {
    const cal = await getCalendar();
    try {
      await cal.events.delete({ calendarId: calendarId(), eventId: gcalEventId, sendUpdates: 'all' });
    } catch (err) {
      if (!isGone(err)) throw err; // already gone in gcal = success
    }
    await prisma.cpScheduledSession.update({
      where: { id: sessionId },
      data: { gcalEventId: null },
    });
    console.log(`[gcalSync] session ${sessionId} → removed event ${gcalEventId}`);
  } catch (err) {
    console.warn(`[gcalSync] session ${sessionId} event removal failed:`, err instanceof Error ? err.message : err);
  }
}
