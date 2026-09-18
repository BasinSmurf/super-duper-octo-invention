/**
 * sendForSigning.ts — Email-based signature request flow.
 *
 * Generates ticket/invoice PDF, fires email to customer approver + billing@,
 * creates/updates SignatureRequest row in DB.
 *
 * Always CCs billing@basinsafetyus.com regardless of who the customer contact is.
 * If this is a resend, increments sendCount and updates lastSentAt.
 */

import { prisma } from '../index.js';
import { sendMail, FROM_ADDRESS, BILLING_CC, mailerConfigured } from './mailer.js';
import { generateTicketPdf } from './ticketPdfGenerator.js';
import { generateInvoicePdf } from './invoicePdfGenerator.js';
import { pdfToBuffer } from '../utils/pdfToBuffer.js';

interface SendForSigningOpts {
  type: 'ticket' | 'invoice';
  referenceId: string;           // ticket.id or invoice.id
  data: any;                     // full ticket/invoice row for PDF generation
  contactEmail: string;          // customer approver email
  contactName?: string;
  sentByUserId: string;
  message?: string;              // optional custom message
}

export async function sendForSigning(opts: SendForSigningOpts): Promise<{ success: boolean; resend: boolean }> {
  const { type, referenceId, data, contactEmail, contactName, sentByUserId, message } = opts;

  if (!mailerConfigured) {
    throw new Error('Email sending is not configured (GOOGLE_SA_KEY_PATH / GOOGLE_MAIL_FROM missing)');
  }

  // ── 1. Generate PDF ──────────────────────────────────────────────────────
  const pdfDoc = type === 'invoice'
    ? generateInvoicePdf(data)
    : generateTicketPdf(data);
  const pdfBuffer = await pdfToBuffer(pdfDoc);

  const refLabel = type === 'invoice'
    ? data.invoiceNumber
    : data.ticketNumber || 'Draft';
  const customerName = type === 'invoice'
    ? data.companyName
    : data.company?.name || 'Customer';
  const filename = `${refLabel}.pdf`;

  // ── 2. Build and send email ──────────────────────────────────────────────
  const docLabel = type === 'invoice' ? 'Invoice' : 'Service Ticket';
  const subject = `Signature Requested — Basin Safety ${docLabel} ${refLabel}`;

  const totalAmount = data.total != null ? Number(data.total) : null;
  const html = buildEmailHtml({
    docLabel,
    refLabel,
    customerName,
    totalAmount,
    description: data.workDescription || data.notes || '',
    customMessage: message,
  });

  await sendMail({
    from: FROM_ADDRESS,
    to: contactEmail,
    cc: BILLING_CC,
    subject,
    html,
    attachments: [
      {
        filename,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });

  // ── 3. Upsert SignatureRequest row ────────────────────────────────────────
  const existing = await prisma.signatureRequest.findFirst({
    where: {
      ...(type === 'ticket'
        ? { ticketId: referenceId }
        : { invoiceId: referenceId }),
      status: 'PENDING',
    },
  });

  if (existing) {
    // Resend — bump counter, update last sent timestamp
    await prisma.signatureRequest.update({
      where: { id: existing.id },
      data: {
        sendCount: { increment: 1 },
        lastSentAt: new Date(),
        sentToEmail: contactEmail,       // in case contact changed
        sentToName: contactName || existing.sentToName,
      },
    });
  } else {
    // First send — create request row
    await prisma.signatureRequest.create({
      data: {
        ...(type === 'ticket' ? { ticketId: referenceId } : { invoiceId: referenceId }),
        status: 'PENDING',
        sentToEmail: contactEmail,
        sentToName: contactName || null,
        firstSentAt: new Date(),
        lastSentAt: new Date(),
        sendCount: 1,
        sentById: sentByUserId,
      },
    });

    // Update signatureStatus on the parent record
    if (type === 'ticket') {
      await prisma.serviceTicket.update({
        where: { id: referenceId },
        data: { signatureStatus: 'PENDING', status: 'awaiting_signature' },
      });
    } else {
      await prisma.invoice.update({
        where: { id: referenceId },
        data: { signatureStatus: 'PENDING', status: 'awaiting_signature' },
      });
    }
  }

  return { success: true, resend: !!existing };
}


// ── Email template ──────────────────────────────────────────────────────────

function buildEmailHtml(opts: {
  docLabel: string;
  refLabel: string;
  customerName: string;
  totalAmount: number | null;
  description: string;
  customMessage?: string;
}): string {
  const { docLabel, refLabel, customerName, totalAmount, description, customMessage } = opts;
  const appUrl = process.env.APP_BASE_URL || 'https://service.basinsafetyus.com';

  const amountLine = totalAmount != null
    ? `<p style="margin:0 0 8px">Amount: <strong>$${totalAmount.toFixed(2)}</strong></p>`
    : '';
  const descLine = description
    ? `<p style="margin:0 0 8px;color:#555">${escapeHtml(description.substring(0, 200))}</p>`
    : '';
  const customLine = customMessage
    ? `<p style="margin:16px 0;color:#333;font-style:italic">${escapeHtml(customMessage)}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:600px;margin:0 auto;padding:24px">

  <img src="${appUrl}/logo.png" alt="Basin Safety" style="height:48px;margin-bottom:24px" onerror="this.style.display='none'">

  <p>Hello,</p>

  <p>Please review and sign the attached ${docLabel} from Basin Safety.</p>

  <div style="background:#f7f7f7;border-left:3px solid #1a5fa8;padding:14px 18px;margin:20px 0;border-radius:2px">
    <p style="margin:0 0 4px;font-weight:bold">${docLabel} ${escapeHtml(refLabel)}</p>
    ${descLine}
    ${amountLine}
  </div>

  ${customLine}

  <p>
    Please print, sign, and return a scanned copy by replying to this email,
    or contact us at <a href="mailto:${BILLING_CC}">${BILLING_CC}</a> with any questions.
  </p>

  <p>Thank you,<br>
  <strong>Basin Safety, LLC</strong><br>
  <a href="mailto:${BILLING_CC}">${BILLING_CC}</a>
  </p>

  <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
  <p style="font-size:11px;color:#aaa">
    This message was sent to ${escapeHtml(customerName)}. A copy has been retained by Basin Safety for records purposes.
  </p>

</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
