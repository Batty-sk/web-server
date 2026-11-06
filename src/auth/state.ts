import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

import { SESSION_SECRET } from '../config.js';
import { clearCookie, readCookie, setCookie } from './cookies.js';
import type { Audience, ProviderName } from './types.js';

/** Everything the callback needs to trust the response, kept server-signed in a ten-minute cookie. */
export interface PendingSignIn {
  provider: ProviderName;
  audience: Audience;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

const COOKIE = 'sl_oauth';
const TTL_MS = 10 * 60 * 1000;

const sign = (payload: string) => createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');

export const random = () => randomBytes(32).toString('base64url');

export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export const startPending = (
  res: Response,
  path: string,
  init: Pick<PendingSignIn, 'provider' | 'audience' | 'returnTo'>,
): PendingSignIn => {
  const pending: PendingSignIn = { ...init, state: random(), nonce: random(), verifier: random(), exp: Date.now() + TTL_MS };
  const payload = Buffer.from(JSON.stringify(pending)).toString('base64url');
  setCookie(res, COOKIE, `${payload}.${sign(payload)}`, { path, maxAgeMs: TTL_MS, sameSite: 'none' });
  return pending;
};

/** Reads and consumes the pending sign-in. Returns null if it's missing, forged or expired. */
export const takePending = (req: Request, res: Response, path: string): PendingSignIn | null => {
  const raw = readCookie(req, COOKIE);
  clearCookie(res, COOKIE, path);
  if (!raw) return null;

  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const pending = JSON.parse(Buffer.from(payload, 'base64url').toString()) as PendingSignIn;
    return pending.exp > Date.now() ? pending : null;
  } catch {
    return null;
  }
};

export const sameValue = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
