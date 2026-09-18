/**
 * mailer.ts — sends email via the Gmail API, using the same domain-wide-
 * delegated service account as googleGroups.ts (GOOGLE_SA_KEY_PATH),
 * impersonating a real Workspace mailbox (GOOGLE_MAIL_FROM).
 *
 * Google Workspace setup:
 *   1. Reuse the existing service account (same project as Directory API).
 *   2. Enable the Gmail API in that Cloud project.
 *   3. Admin console → Security → API Controls → Domain-wide Delegation:
 *      add scope https://www.googleapis.com/auth/gmail.send to the SAME
 *      numeric Client ID already authorized for the Directory scopes.
 *   4. GOOGLE_MAIL_FROM must be a real Workspace mailbox (e.g.
 *      notifications@basinsafetyus.com) — Gmail API send requires
 *      impersonating an actual user, not an arbitrary address.
 *
 * If GOOGLE_SA_KEY_PATH / GOOGLE_MAIL_FROM are not set, sendMail() throws
 * and mailerConfigured is false — callers should check before sending.
 */

import { google } from 'googleapis';
// @ts-ignore — no bundled types; this is nodemailer's internal MIME builder,
// used only to compose a raw RFC 2822 message (attachments, html, cc, etc.)
// for the Gmail API. No SMTP transport involved.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

const GOOGLE_SA_KEY_PATH = process.env.GOOGLE_SA_KEY_PATH || '';
const GOOGLE_MAIL_FROM = process.env.GOOGLE_MAIL_FROM || '';

export const mailerConfigured = !!(GOOGLE_SA_KEY_PATH && GOOGLE_MAIL_FROM);

let _authClient: any = null;

async function getGmailClient() {
  if (!GOOGLE_SA_KEY_PATH || !GOOGLE_MAIL_FROM) return null;
  if (_authClient) return google.gmail({ version: 'v1', auth: _authClient });

  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SA_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    clientOptions: { subject: GOOGLE_MAIL_FROM },
  });

  const client: any = await auth.getClient();
  const gmail = google.gmail({ version: 'v1', auth: client });

  // Verify by minting the token, NOT by calling a Gmail method. The JWT->token
  // exchange is exactly what needs proving: that domain-wide delegation lets
  // this service account impersonate GOOGLE_MAIL_FROM for the gmail.send scope.
  //
  // Do NOT probe with users.getProfile(): that method requires a *read* scope
  // (gmail.readonly / gmail.metadata / mail.google.com), so a send-only token
  // always gets back "Request had insufficient authentication scopes" — even on
  // a perfectly configured account. getGmailClient() throws on a failed probe,
  // so that false alarm turned a healthy config into a total send outage.
  // Requesting a read scope just to health-check is the wrong trade: it grants
  // the app the ability to READ the mailbox it only needs to send from.
  try {
    const token = await client.getAccessToken();
    if (!token?.token) throw new Error('token exchange returned no access token');
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[mailer] Gmail API verify failed:', msg);
    console.error('[mailer] TROUBLESHOOTING:');
    if (msg.includes('invalid_grant') || msg.includes('Invalid email or User ID')) {
      console.error(`  GOOGLE_MAIL_FROM (${GOOGLE_MAIL_FROM}) is not a real Workspace USER mailbox.`);
      console.error('  Groups and aliases cannot be impersonated — domain-wide delegation');
      console.error('  resolves the subject to an actual account. Point this at a real');
      console.error('  mailbox; to send under another address, add that address as a');
      console.error('  "Send mail as" alias on the mailbox and set the From header to it.');
    } else if (msg.includes('unauthorized_client')) {
      console.error('  admin.google.com -> Security -> API Controls -> Domain-wide Delegation:');
      console.error('  the numeric Client ID for this service account is missing the scope');
      console.error('    https://www.googleapis.com/auth/gmail.send');
    } else {
      console.error('  1. console.cloud.google.com -> APIs & Services -> Library -> Gmail API -> ENABLED');
      console.error('  2. Confirm GOOGLE_SA_KEY_PATH points at the delegated service account key');
      console.error(`  3. GOOGLE_MAIL_FROM (${GOOGLE_MAIL_FROM}) must be a real Workspace mailbox`);
    }
    throw err;
  }

  _authClient = client;
  console.log('[mailer] Gmail API ready —', GOOGLE_MAIL_FROM);
  return gmail;
}

// Best-effort startup check so config problems surface in the boot log
// rather than on the first real send.
if (mailerConfigured) {
  getGmailClient().catch(() => {
    _authClient = null; // let the next real send retry after a config fix
  });
} else {
  console.warn('[mailer] GOOGLE_SA_KEY_PATH / GOOGLE_MAIL_FROM not set — email sending disabled');
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendMailOpts {
  from?: string;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  html: string;
  attachments?: MailAttachment[];
}

export async function sendMail(opts: SendMailOpts): Promise<void> {
  const gmail = await getGmailClient();
  if (!gmail) {
    throw new Error('Email sending is not configured (GOOGLE_SA_KEY_PATH / GOOGLE_MAIL_FROM missing)');
  }

  const composer = new MailComposer({
    from: opts.from || FROM_ADDRESS,
    to: opts.to,
    cc: opts.cc,
    replyTo: opts.replyTo,
    subject: opts.subject,
    html: opts.html,
    attachments: opts.attachments,
  });

  const built: Buffer = await new Promise((resolve, reject) => {
    composer.compile().build((err: Error | null, message: Buffer) => {
      if (err) reject(err);
      else resolve(message);
    });
  });

  const raw = built
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  } catch (err: any) {
    // Auth errors (revoked delegation, disabled API) — clear cached client
    // so a config fix takes effect without a restart.
    if (err.code === 401 || err.code === 403) {
      _authClient = null;
    }
    throw err;
  }
}

export const FROM_ADDRESS = `"Basin Safety" <${GOOGLE_MAIL_FROM || 'noreply@basinsafetyus.com'}>`;
export const BILLING_CC = 'billing@basinsafetyus.com';
