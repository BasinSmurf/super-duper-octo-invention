import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error('Error:', err);

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Prisma known errors
  if (err.name === 'PrismaClientKnownRequestError') {
    const prismaErr = err as any;
    if (prismaErr.code === 'P2002') {
      res.status(409).json({ error: 'A record with this value already exists', fields: prismaErr.meta?.target });
      return;
    }
    if (prismaErr.code === 'P2025') {
      res.status(404).json({ error: 'Record not found' });
      return;
    }
    if (['P2000', 'P2003', 'P2011', 'P2012', 'P2020'].includes(prismaErr.code)) {
      res.status(400).json({ error: 'Invalid value or related record' });
      return;
    }
  }
  if (err.name === 'PrismaClientValidationError') {
    res.status(400).json({ error: 'Invalid request data' });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
}

/** Never echo ORM statements, driver messages, or filesystem paths to a device. */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof Error && !/Prisma|Driver|Adapter/i.test(err.name) && !/Invalid .*invocation|\bquery\b|[A-Z]:\\/i.test(err.message)) return err.message;
  return 'Unable to save this change. Check the data and retry.';
}
