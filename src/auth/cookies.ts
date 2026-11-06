import type { Request, Response } from 'express';

import { IS_PRODUCTION } from '../config.js';

export const readCookie = (req: Request, name: string): string | undefined => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
};

interface CookieOptions {
  path: string;
  maxAgeMs: number;
  /** "none" is only for the OAuth state cookie, which Apple's cross-site form post must carry. */
  sameSite?: 'lax' | 'none';
}

export const setCookie = (res: Response, name: string, value: string, { path, maxAgeMs, sameSite = 'lax' }: CookieOptions) => {
  // Browsers refuse SameSite=None without Secure, and Secure needs HTTPS, so development falls back to Lax.
  const none = sameSite === 'none' && IS_PRODUCTION;
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    'HttpOnly',
    `SameSite=${none ? 'None' : 'Lax'}`,
    IS_PRODUCTION ? 'Secure' : '',
  ].filter(Boolean);
  res.append('Set-Cookie', attributes.join('; '));
};

export const clearCookie = (res: Response, name: string, path: string) =>
  setCookie(res, name, '', { path, maxAgeMs: 0 });
