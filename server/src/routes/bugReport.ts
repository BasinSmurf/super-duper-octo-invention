import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../index.js';
import { getFileStore } from '../services/fileStore.js';
import { sendMail, mailerConfigured, FROM_ADDRESS, type MailAttachment } from '../services/mailer.js';

export const bugReportRouter = Router();

interface LogEntry {
  ts: number;
  level: string;
  text: string;
}

/** Where bug reports are emailed. Group address by default; env-overridable. */
const RECIPIENT = process.env.BUG_REPORT_EMAIL || 'itsupport@basinsafetyus.com';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

bugReportRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, title, description, screenshot, context, logs } = req.body as {
      type?: string;
      title?: string;
      description?: string;
      screenshot?: string | null;
      context?: Record<string, unknown>;
      logs?: LogEntry[];
    };

    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    const kind = type === 'feature' ? 'Feature Request' : 'Bug Report';
    const ctx = context || {};

    // 1. Persist first — this is the source of truth and survives a mail
    //    outage, so the report is never lost (and shows on the Ops dashboard).
    const report = await prisma.bugReport.create({
      data: {
        type: type === 'feature' ? 'feature' : 'bug',
        title: title.trim(),
        description: description?.trim() || null,
        reporterId: req.user?.userId ?? null,
        reporterName: (ctx.userName as string) ?? null,
        reporterEmail: req.user?.email ?? null,
        reporterRole: (ctx.userRole as string) ?? null,
        route: (ctx.route as string) ?? null,
        context: ctx as object,
        logs: (Array.isArray(logs) ? logs : []) as object,
      },
    });

    // 2. Store the screenshot to the file store (not the DB) and link it.
    //    The email attachment is built from the bytes we already hold, NOT from
    //    a successful store write — those are independent failure domains, and
    //    losing object storage should not also silently strip the screenshot
    //    off the email.
    let screenshotKey: string | null = null;
    let screenshotAttachment: MailAttachment | null = null;
    if (typeof screenshot === 'string' && screenshot.startsWith('data:image/')) {
      const match = screenshot.match(/^data:image\/(\w+);base64,(.+)$/);
      if (match) {
        const mime = `image/${match[1]}`;
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const buf = Buffer.from(match[2], 'base64');
        screenshotAttachment = { filename: `screenshot.${ext}`, content: buf, contentType: mime };
        console.log(`[bug-report] screenshot received: ${mime}, ${Math.round(buf.length / 1024)}kb`);
        try {
          screenshotKey = `bug-reports/${report.id}/screenshot.${ext}`;
          await getFileStore().write(screenshotKey, buf, mime);
          await prisma.bugReport.update({
            where: { id: report.id },
            data: { screenshotKey },
          });
        } catch (e) {
          console.warn('[bug-report] failed to store screenshot (still attaching to email):', e);
          screenshotKey = null;
        }
      } else {
        console.warn('[bug-report] screenshot present but not a parseable data URL — not attached');
      }
    } else if (screenshot != null) {
      console.warn(`[bug-report] screenshot field was ${typeof screenshot}, not a data:image/ URL — not attached`);
    } else {
      console.log('[bug-report] no screenshot in payload (client capture returned null)');
    }

    // 3. Best-effort email. If the mailer is off (e.g. dev), the report is
    //    still saved above; we just record emailed=false.
    let emailed = false;
    if (mailerConfigured) {
      try {
        const logHtml =
          Array.isArray(logs) && logs.length
            ? `<pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;font-size:12px;overflow:auto;white-space:pre-wrap;">${logs
                .map((l) => `${esc(new Date(l.ts).toISOString())} [${esc(l.level)}] ${esc(l.text)}`)
                .join('\n')}</pre>`
            : '<p style="color:#64748b;">No recent console logs captured.</p>';

        const html = `
          <div style="font-family:system-ui,sans-serif;color:#0f172a;">
            <h2 style="margin:0 0 4px;">${esc(kind)}: ${esc(title)}</h2>
            <p style="color:#64748b;margin:0 0 16px;">
              From ${esc(ctx.userName)} (${esc(ctx.userRole)} · ${esc(req.user?.email)})
            </p>
            ${description ? `<p style="white-space:pre-wrap;">${esc(description)}</p>` : ''}
            <h3 style="margin:20px 0 6px;">Context</h3>
            <ul style="font-size:13px;color:#334155;line-height:1.6;">
              <li><b>Route:</b> ${esc(ctx.route)}</li>
              <li><b>URL:</b> ${esc(ctx.url)}</li>
              <li><b>Online:</b> ${esc(ctx.isOnline)}</li>
              <li><b>Sync:</b> ${esc(JSON.stringify(ctx.sync))}</li>
              <li><b>Screen:</b> ${esc(ctx.screen)}</li>
              <li><b>App version:</b> ${esc(ctx.appVersion)}</li>
              <li><b>Captured:</b> ${esc(ctx.capturedAt)}</li>
              <li><b>User agent:</b> ${esc(ctx.userAgent)}</li>
            </ul>
            <h3 style="margin:20px 0 6px;">Recent logs</h3>
            ${logHtml}
          </div>
        `;

        const attachments = screenshotAttachment ? [screenshotAttachment] : [];

        await sendMail({
          from: FROM_ADDRESS,
          to: RECIPIENT,
          replyTo: req.user?.email,
          subject: `[${kind}] ${title}`,
          html,
          attachments,
        });
        emailed = true;
        await prisma.bugReport.update({ where: { id: report.id }, data: { emailed: true } });
      } catch (e) {
        console.error('[bug-report] email send failed (report still saved):', e);
      }
    } else {
      console.warn('[bug-report] mailer not configured — report saved but not emailed:', report.id);
    }

    res.json({ ok: true, id: report.id, emailed });
  } catch (err) {
    next(err);
  }
});
