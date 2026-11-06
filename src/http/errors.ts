import type { ErrorRequestHandler } from 'express';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const status =
    error instanceof HttpError ? error.status : typeof error?.status === 'number' ? (error.status as number) : 500;
  const message =
    error instanceof HttpError
      ? error.message
      : status === 413
        ? 'That file is too large. Images can be up to 10 MB.'
        : status < 500
          ? 'The request couldn’t be read.'
          : 'Something went wrong. Your work is safe — try again.';

  if (status >= 500) console.error(error);
  res.status(status).json({ error: message, field: error instanceof HttpError ? error.field : undefined });
};
