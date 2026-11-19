/**
 * v1/respond.ts — shared response plumbing for the /api/v1 surface.
 *
 *  - V1Error  → thrown by handlers/middleware; rendered by v1ErrorHandler into
 *    the spec's { error: { code, message, details? } } envelope.
 *  - Cursor pagination over (updatedAt DESC, id DESC). Cursor is an opaque
 *    base64url of `${updatedAtISO}|${id}`.
 *  - runList / sendOne keep per-route handlers to a few lines.
 *  - num/dateOnly/iso normalize Prisma Decimal/Date to the wire shapes the
 *    DTO-MAPPING.md prescribes.
 */
import type { Request, Response, NextFunction } from 'express';

export class V1Error extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'V1Error';
  }
}

// ── value normalizers ─────────────────────────────────────────────────────────
export function num(d: unknown): number | null {
  if (d === null || d === undefined) return null;
  const n = typeof d === 'number' ? d : Number(d as never);
  return Number.isNaN(n) ? null : n;
}
export function dateOnly(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// ── pagination ────────────────────────────────────────────────────────────────
interface CursorParts { updatedAt: Date; id: string; }

export function encodeCursor(row: CursorParts): string {
  return Buffer.from(`${row.updatedAt.toISOString()}|${row.id}`).toString('base64url');
}
export function decodeCursor(c: string): CursorParts | null {
  try {
    const s = Buffer.from(c, 'base64url').toString('utf8');
    const i = s.lastIndexOf('|');
    if (i < 0) return null;
    const updatedAt = new Date(s.slice(0, i));
    const id = s.slice(i + 1);
    if (Number.isNaN(updatedAt.getTime()) || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

export function parseLimit(q: unknown, def = 50, max = 200): number {
  if (q === undefined) return def;
  const n = typeof q === 'string' && /^\d+$/.test(q) ? Number(q) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new V1Error(400, 'invalid_parameter', `Invalid limit: expected an integer from 1 to ${max}`, { param: 'limit', min: 1, max });
  }
  return n;
}

/** Build the WHERE fragment that selects rows "after" the cursor in DESC order. */
function cursorWhere(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  const c = decodeCursor(cursor);
  if (!c) throw new V1Error(400, 'bad_cursor', 'Invalid pagination cursor');
  return {
    OR: [
      { updatedAt: { lt: c.updatedAt } },
      { AND: [{ updatedAt: c.updatedAt }, { id: { lt: c.id } }] },
    ],
  };
}

function combineWhere(a: unknown, b: unknown): unknown {
  if (a && b) return { AND: [a, b] };
  return a ?? b ?? undefined;
}

type Row = { id: string; updatedAt: Date };

/** Generic cursor-paginated list. `findMany` is a thin closure over a Prisma delegate. */
export async function runList<TRow extends Row, TDto>(
  res: Response,
  opts: {
    findMany: (args: { where: unknown; take: number; orderBy: unknown }) => Promise<TRow[]>;
    where?: unknown;
    cursor?: string;
    limit: number;
    map: (row: TRow) => TDto;
  },
): Promise<void> {
  const where = combineWhere(opts.where, cursorWhere(opts.cursor));
  const rows = await opts.findMany({
    where,
    take: opts.limit + 1,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  });
  const hasMore = rows.length > opts.limit;
  const pageRows = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  res.json({
    data: pageRows.map(opts.map),
    page: { nextCursor: hasMore && last ? encodeCursor(last) : null, hasMore },
  });
}

/** Single resource with ETag / Last-Modified + If-None-Match → 304. */
export function sendOne<TRow extends { updatedAt: Date }, TDto>(
  req: Request,
  res: Response,
  row: TRow | null,
  map: (row: TRow) => TDto,
): void {
  if (!row) throw new V1Error(404, 'not_found', 'Resource not found');
  const etag = `"${row.updatedAt.getTime()}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', row.updatedAt.toUTCString());
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.json(map(row));
}

// ── error handler (mounted at the end of the v1 router) ─────────────────────────
export function v1ErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  if (err instanceof V1Error) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }
  console.error('[v1] unhandled error:', err);
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
}
