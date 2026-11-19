import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import type { Prisma } from '../db.js';

export const printJobsRouter = Router();

// GET /api/print-jobs — audit + failure list. ?status=FAILED&hours=24&limit=100
printJobsRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const where: Prisma.PrintJobWhereInput = {};
    if (req.query.status) where.status = String(req.query.status) as Prisma.PrintJobWhereInput['status'];
    if (req.query.hours) {
      const hours = parseInt(String(req.query.hours), 10);
      if (hours > 0) where.createdAt = { gte: new Date(Date.now() - hours * 3_600_000) };
    }

    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const jobs = await prisma.printJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        printer: { select: { name: true } },
        shopWorkOrder: { select: { workOrderNumber: true } },
        shopWorkOrderItem: { select: { serialNumber: true } },
      },
    });
    res.json({ data: jobs });
  } catch (err) {
    next(err);
  }
});

// POST /api/print-jobs/:id/retry — requeue a FAILED job (master doc §9.8)
printJobsRouter.post('/:id/retry', async (req: Request, res: Response, next) => {
  try {
    const job = await prisma.printJob.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, status: true },
    });
    if (!job) throw new AppError(404, 'Print job not found');
    if (job.status !== 'FAILED') throw new AppError(400, 'Only FAILED jobs can be retried');

    const updated = await prisma.printJob.update({
      where: { id: job.id },
      data: { status: 'QUEUED', attempts: 0, errorMessage: null, nextAttemptAt: null, completedAt: null },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});
