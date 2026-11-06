import { createHash, randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';

import { SESSION_TTL } from '../config.js';
import { one, run } from '../db/client.js';
import { HttpError } from '../http/errors.js';
import { clearCookie, readCookie, setCookie } from './cookies.js';
import type { Audience } from './types.js';

/** Separate cookies, scoped apart: an admin session is never sent to user endpoints, and vice versa. */
const COOKIES: Record<Audience, { name: string; path: string }> = {
  user: { name: 'sl_session', path: '/' },
  admin: { name: 'sl_admin', path: '/admin' },
};

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export const createSession = async (req: Request, res: Response, audience: Audience, principalId: string) => {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await run(
    'INSERT INTO sessions (token_hash, audience, principal_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    [hash(token), audience, principalId, new Date(now).toISOString(), new Date(now + SESSION_TTL[audience]).toISOString(), req.headers['user-agent']?.slice(0, 200) ?? null],
  );
  const cookie = COOKIES[audience];
  setCookie(res, cookie.name, token, { path: cookie.path, maxAgeMs: SESSION_TTL[audience] });
};

/** Returns the signed-in principal's id, renewing sessions that are past halfway. */
export const readSession = async (req: Request, res: Response, audience: Audience): Promise<string | null> => {
  const cookie = COOKIES[audience];
  const token = readCookie(req, cookie.name);
  if (!token) return null;

  const row = await one<{ principal_id: string; expires_at: string }>(
    'SELECT principal_id, expires_at FROM sessions WHERE token_hash = ? AND audience = ? AND expires_at > ?',
    [hash(token), audience, new Date().toISOString()],
  );
  if (!row) {
    clearCookie(res, cookie.name, cookie.path);
    return null;
  }

  const remaining = new Date(row.expires_at).getTime() - Date.now();
  // Admin sessions don't slide: twelve hours, then sign in again.
  if (audience === 'user' && remaining < SESSION_TTL.user / 2) {
    await run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [new Date(Date.now() + SESSION_TTL.user).toISOString(), hash(token)]);
    setCookie(res, cookie.name, token, { path: cookie.path, maxAgeMs: SESSION_TTL.user });
  }
  return row.principal_id;
};

export const endSession = async (req: Request, res: Response, audience: Audience) => {
  const cookie = COOKIES[audience];
  const token = readCookie(req, cookie.name);
  if (token) await run('DELETE FROM sessions WHERE token_hash = ?', [hash(token)]);
  clearCookie(res, cookie.name, cookie.path);
};

export const endAllSessions = (audience: Audience, principalId: string) =>
  run('DELETE FROM sessions WHERE audience = ? AND principal_id = ?', [audience, principalId]);

export const pruneSessions = () => run('DELETE FROM sessions WHERE expires_at <= ?', [new Date().toISOString()]);

export const requireUser: RequestHandler = async (req, res, next) => {
  const id = await readSession(req, res, 'user');
  if (!id) throw new HttpError(401, 'Sign in to continue.');
  res.locals.userId = id;
  next();
};

export const requireAdmin: RequestHandler = async (req, res, next) => {
  const id = await readSession(req, res, 'admin');
  if (!id) throw new HttpError(401, 'Your session has ended. Sign in again.');
  const admin = await one<{ id: string; role: string }>('SELECT id, role FROM admins WHERE id = ?', [id]);
  if (!admin) throw new HttpError(401, 'Your access has been removed.');
  res.locals.adminId = admin.id;
  res.locals.adminRole = admin.role;
  next();
};
