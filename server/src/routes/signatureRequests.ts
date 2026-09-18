/**
 * signatureRequests.ts — Routes for email-based signature flow.
 *
 * Endpoints:
 *   POST /send                — Send ticket/invoice PDF for signing via email
 *   POST /resend/:id          — Resend a pending signature request
 *   GET  /                    — List signature requests (holding tank feed)
 *   PATCH /:id/resolve        — Mark as received (billing uploads signed doc)
 *   PATCH /:id/void           — Void a pending request
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { createAuditLog } from '../utils/auditLog.js';
import { sendForSigning } from '../services/sendForSigning.js';

export const signatureRequestsRouter = Router();

// ── POST /send ──────────────────────────────────────────────────────────────
// Body: { type: "ticket"|"invoice", referenceId: string, approverEmail: string, approverName?: string, message?: string }
signatureRequestsRouter.post('/send', async (req: Request, res: Response, next) => {
  try {
    const { type, referenceId, approverEmail, approverName, message } = req.body;

    if (!['ticket', 'invoice'].includes(type) || !referenceId) {
      throw new AppError(400, 'type ("ticket"|"invoice") and referenceId are required');
    }
    if (!approverEmail) {
      throw new AppError(400, 'approverEmail is required');
    }

    let data: any;

    if (type === 'ticket') {
      const ticket = await prisma.serviceTicket.findUnique({
        where: { id: referenceId },
        include: {
          company: true,
          field: true,
          pad: true,
          well: true,
          assignedTech: { select: { id: true, name: true, email: true } },
          lineItems: {
            include: { product: { select: { id: true, partNumber: true, name: true } } },
            orderBy: { sortOrder: 'asc' },
          },
          fitTestRecords: true,
          billingProfile: true,
        },
      });
      if (!ticket) throw new AppError(404, 'Ticket not found');

      // Validate billing profile requires ticket signatures
      const sigReq = ticket.billingProfile?.signatureRequired;
      if (sigReq !== 'ticket' && sigReq !== 'both') {
        throw new AppError(400, 'Billing profile does not require ticket signatures');
      }

      // Must be in supervisor_review or awaiting_signature (resend)
      if (ticket.status !== 'supervisor_review' && ticket.status !== 'awaiting_signature') {
        throw new AppError(400, `Cannot send for signature from status: ${ticket.status}`);
      }

      data = ticket;
    } else {
      const invoice = await prisma.invoice.findUnique({
        where: { id: referenceId },
        include: {
          company: true,
          approvedBy: true,
          createdBy: true,
          lineItems: {
            include: { product: { select: { id: true, partNumber: true, name: true } } },
            orderBy: { sortOrder: 'asc' },
          },
        },
      });
      if (!invoice) throw new AppError(404, 'Invoice not found');

      if (invoice.status !== 'approved' && invoice.status !== 'awaiting_signature') {
        throw new AppError(400, `Cannot send for signature from status: ${invoice.status}`);
      }

      data = invoice;
    }

    const result = await sendForSigning({
      type,
      referenceId,
      data,
      contactEmail: approverEmail,
      contactName: approverName,
      sentByUserId: req.user!.userId,
      message,
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: type === 'ticket' ? 'service_ticket' : 'invoice',
      entityId: referenceId,
      action: 'status_change',
      changes: {
        action: result.resend ? 'signature_resend' : 'signature_send',
        approverEmail,
        to: 'awaiting_signature',
      },
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      resend: result.resend,
      message: result.resend
        ? 'Reminder sent and send count updated.'
        : 'Sent for signature.',
    });
  } catch (err) {
    next(err);
  }
});

// ── GET / ───────────────────────────────────────────────────────────────────
// Signature queue — list pending (or filter by status).
signatureRequestsRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const { status = 'PENDING' } = req.query;

    const requests = await prisma.signatureRequest.findMany({
      where: { status: (status as string).toUpperCase() as any },
      orderBy: { firstSentAt: 'asc' },  // oldest first
      include: {
        ticket: {
          select: {
            id: true,
            ticketNumber: true,
            ticketType: true,
            status: true,
            serviceDate: true,
            total: true,
            company: { select: { id: true, name: true } },
            assignedTech: { select: { id: true, name: true } },
          },
        },
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            total: true,
            companyName: true,
            invoiceDate: true,
          },
        },
        sentBy: { select: { id: true, name: true } },
        resolvedBy: { select: { id: true, name: true } },
      },
    });

    res.json({ data: requests, total: requests.length });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id/resolve ──────────────────────────────────────────────────────
// Body: { notes?: string, signedDocumentUrl?: string }
signatureRequestsRouter.patch('/:id/resolve', async (req: Request, res: Response, next) => {
  try {
    const { notes, signedDocumentUrl } = req.body;

    const sigReq = await prisma.signatureRequest.findUnique({
      where: { id: req.params.id as string },
    });
    if (!sigReq) throw new AppError(404, 'Signature request not found');
    if (sigReq.status !== 'PENDING') throw new AppError(400, `Cannot resolve — status is ${sigReq.status}`);

    const updated = await prisma.signatureRequest.update({
      where: { id: sigReq.id },
      data: {
        status: 'RECEIVED',
        resolvedAt: new Date(),
        resolvedById: req.user!.userId,
        notes,
        signedDocumentUrl,
      },
    });

    // Transition parent record forward
    if (updated.ticketId) {
      await prisma.serviceTicket.update({
        where: { id: updated.ticketId },
        data: { signatureStatus: 'RECEIVED', status: 'billing_queue' },
      });
    } else if (updated.invoiceId) {
      await prisma.invoice.update({
        where: { id: updated.invoiceId },
        data: { signatureStatus: 'RECEIVED', status: 'queued' },
      });
    }

    await createAuditLog({
      userId: req.user!.userId,
      entityType: updated.ticketId ? 'service_ticket' : 'invoice',
      entityId: (updated.ticketId || updated.invoiceId)!,
      action: 'status_change',
      changes: { from: 'awaiting_signature', to: updated.ticketId ? 'billing_queue' : 'queued', signatureResolved: true },
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id/void ─────────────────────────────────────────────────────────
signatureRequestsRouter.patch('/:id/void', async (req: Request, res: Response, next) => {
  try {
    const sigReq = await prisma.signatureRequest.findUnique({
      where: { id: req.params.id as string },
    });
    if (!sigReq) throw new AppError(404, 'Signature request not found');
    if (sigReq.status !== 'PENDING') throw new AppError(400, `Cannot void — status is ${sigReq.status}`);

    const updated = await prisma.signatureRequest.update({
      where: { id: sigReq.id },
      data: {
        status: 'VOIDED',
        resolvedAt: new Date(),
        resolvedById: req.user!.userId,
      },
    });

    // Reset parent record back to previous state
    if (updated.ticketId) {
      await prisma.serviceTicket.update({
        where: { id: updated.ticketId },
        data: { signatureStatus: 'NONE', status: 'supervisor_review' },
      });
    } else if (updated.invoiceId) {
      await prisma.invoice.update({
        where: { id: updated.invoiceId },
        data: { signatureStatus: 'NONE', status: 'approved' },
      });
    }

    await createAuditLog({
      userId: req.user!.userId,
      entityType: updated.ticketId ? 'service_ticket' : 'invoice',
      entityId: (updated.ticketId || updated.invoiceId)!,
      action: 'status_change',
      changes: { signatureVoided: true },
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
