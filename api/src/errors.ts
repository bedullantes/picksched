import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

const SLOT_TAKEN = 'This time slot is no longer available. Someone else may have just booked it.';

/** Maps a PostgreSQL error (see docs/database-schema.md) to an API error. */
export function fromDbError(err: unknown): ApiError | null {
  const e = err as PgError;
  switch (e?.code) {
    case '23P01':
      if (e.constraint === 'bookings_maintenance_overlap') {
        return new ApiError(409, 'COURT_UNDER_MAINTENANCE', 'The court is closed for maintenance at that time.');
      }
      if (e.constraint === 'court_blocks_booking_overlap') {
        return new ApiError(409, 'BLOCK_OVERLAPS_BOOKINGS',
          'That time overlaps existing bookings. Cancel or move them before blocking it.');
      }
      if (e.constraint === 'court_blocks_no_overlap') {
        return new ApiError(409, 'ALREADY_BLOCKED', 'Part of that time is already blocked for maintenance.');
      }
      return new ApiError(409, 'SLOT_UNAVAILABLE', SLOT_TAKEN);
    case '55006': // object_in_use: booking is in checkout (migration 004)
      return new ApiError(409, 'BOOKING_IN_CHECKOUT',
        'The player is paying for this booking right now. It can be changed once checkout finishes or the hold expires.');
    case '23505':
      return new ApiError(409, 'DUPLICATE', 'That record already exists.');
    case '23503':
      return new ApiError(404, 'NOT_FOUND', 'A referenced record was not found.');
    case '23514':
    case '22023':
      return new ApiError(422, 'INVALID_REQUEST', e.message ?? 'The request is not valid.');
    case '22P02':
    case '22007':
    case '22008':
      return new ApiError(400, 'BAD_REQUEST', 'The request contains an invalid value.');
    case '42501':
      return new ApiError(403, 'FORBIDDEN', 'You do not have permission to do that.');
    case 'P0002':
      return new ApiError(404, 'NOT_FOUND', 'Not found.');
    case '57014': // statement_timeout
    case '55P03': // lock_not_available
      return new ApiError(503, 'DB_TIMEOUT', 'The booking service is busy right now. Please try again in a moment.');
    case '08000':
    case '08001':
    case '08003':
    case '08006':
    case '57P01':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'ETIMEDOUT':
      return new ApiError(503, 'DB_UNAVAILABLE', 'The booking service is temporarily unavailable. Please try again shortly.');
  }
  if (e?.message?.includes('timeout exceeded when trying to connect')) {
    return new ApiError(503, 'DB_UNAVAILABLE', 'The booking service is temporarily unavailable. Please try again shortly.');
  }
  return null;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let apiErr: ApiError;
  if (err instanceof ApiError) {
    apiErr = err;
  } else if (err instanceof ZodError) {
    apiErr = new ApiError(400, 'BAD_REQUEST', 'The request is not valid.',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  } else if ((err as { type?: string })?.type === 'entity.parse.failed') {
    apiErr = new ApiError(400, 'BAD_REQUEST', 'The request body is not valid JSON.');
  } else {
    apiErr = fromDbError(err) ?? new ApiError(500, 'INTERNAL', 'Something went wrong. Please try again.');
    if (apiErr.status >= 500) console.error(err);
  }
  res.status(apiErr.status).json({
    error: { code: apiErr.code, message: apiErr.message, ...(apiErr.details ? { details: apiErr.details } : {}) },
  });
};
