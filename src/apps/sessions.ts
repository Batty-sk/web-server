import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

import { jwtVerify, SignJWT } from 'jose';

import { API_URL } from '../config.js';
import { all, one, run } from '../db/client.js';
import { HttpError } from '../http/errors.js';
import { accessTokenKey } from './keys.js';

export const ACCESS_TOKEN_TTL = 15 * 60;
const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const now = () => new Date().toISOString();

/** OAuth's error shape, which native client libraries expect from the token endpoint. */
export class OAuthError extends HttpError {
  constructor(public readonly code: string, description: string, status = 400) {
    super(status, description);
  }
}

/* Authorization codes --------------------------------------------------------- */

export const issueCode = async (input: { userId: string; clientId: string; redirectUri: string; challenge: string; deviceName: string }) => {
  const code = token();
  await run(
    `INSERT INTO app_auth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, device_name, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [hash(code), input.userId, input.clientId, input.redirectUri, input.challenge, input.deviceName, new Date(Date.now() + CODE_TTL_MS).toISOString()],
  );
  return code;
};

/** Codes work once, for two minutes, for the app that asked, and only with the verifier behind the challenge. */
export const redeemCode = async (input: { code: string; verifier: string; clientId: string; redirectUri: string }) => {
  const row = await one<{ user_id: string; client_id: string; redirect_uri: string; code_challenge: string; device_name: string; expires_at: string }>(
    'SELECT * FROM app_auth_codes WHERE code_hash = ?',
    [hash(input.code)],
  );
  await run('DELETE FROM app_auth_codes WHERE code_hash = ?', [hash(input.code)]);

  if (!row || row.expires_at < now()) throw new OAuthError('invalid_grant', 'That sign-in code has expired. Sign in again.');
  if (row.client_id !== input.clientId || row.redirect_uri !== input.redirectUri) {
    throw new OAuthError('invalid_grant', 'That sign-in code was issued to a different app.');
  }
  const challenge = createHash('sha256').update(input.verifier).digest('base64url');
  if (challenge !== row.code_challenge) throw new OAuthError('invalid_grant', 'The code verifier doesn’t match.');

  return startAppSession(row.user_id, row.client_id, row.device_name);
};

/* Sessions and tokens --------------------------------------------------------- */

const accessToken = (userId: string, sessionId: string, clientId: string) =>
  new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(API_URL)
    .setAudience(clientId)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL}s`)
    .sign(accessTokenKey);

const tokenResponse = async (userId: string, sessionId: string, clientId: string, refresh: string) => ({
  access_token: await accessToken(userId, sessionId, clientId),
  token_type: 'Bearer',
  expires_in: ACCESS_TOKEN_TTL,
  refresh_token: refresh,
});

const startAppSession = async (userId: string, clientId: string, deviceName: string) => {
  const id = randomUUID();
  const refresh = token();
  const timestamp = now();
  await run(
    `INSERT INTO app_sessions (id, user_id, client_id, device_name, refresh_hash, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, clientId, deviceName.slice(0, 80), hash(refresh), timestamp, timestamp, new Date(Date.now() + REFRESH_TTL_MS).toISOString()],
  );
  return tokenResponse(userId, id, clientId, refresh);
};

/** Every refresh hands out a new refresh token. Replaying an old one ends the session for everyone holding it. */
export const refreshAppSession = async (refresh: string, clientId: string) => {
  const presented = hash(refresh);
  const current = await one<{ id: string; user_id: string; client_id: string; expires_at: string }>(
    'SELECT * FROM app_sessions WHERE refresh_hash = ?',
    [presented],
  );

  if (!current) {
    const replayed = await one<{ id: string }>('SELECT id FROM app_sessions WHERE previous_refresh_hash = ?', [presented]);
    if (replayed) {
      await run('DELETE FROM app_sessions WHERE id = ?', [replayed.id]);
      console.warn(`apps: refresh token replayed; session ${replayed.id} revoked.`);
    }
    throw new OAuthError('invalid_grant', 'You’ve been signed out. Sign in again.');
  }
  if (current.client_id !== clientId) throw new OAuthError('invalid_grant', 'That token belongs to a different app.');
  if (current.expires_at < now()) {
    await run('DELETE FROM app_sessions WHERE id = ?', [current.id]);
    throw new OAuthError('invalid_grant', 'You’ve been signed out. Sign in again.');
  }

  const next = token();
  await run(
    `UPDATE app_sessions SET refresh_hash = ?, previous_refresh_hash = ?, last_used_at = ?, expires_at = ? WHERE id = ?`,
    [hash(next), presented, now(), new Date(Date.now() + REFRESH_TTL_MS).toISOString(), current.id],
  );
  return tokenResponse(current.user_id, current.id, current.client_id, next);
};

/** Bearer-token auth for app endpoints. A signed-out Mac stops working at once, not when its token expires. */
export const requireApp: RequestHandler = async (req, res, next) => {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!bearer) throw new OAuthError('invalid_token', 'Sign in to Manuscript to continue.', 401);

  let claims;
  try {
    ({ payload: claims } = await jwtVerify(bearer, accessTokenKey, { issuer: API_URL }));
  } catch {
    throw new OAuthError('invalid_token', 'Your session has expired.', 401);
  }

  const session = await one<{ id: string; user_id: string; client_id: string }>(
    'SELECT id, user_id, client_id FROM app_sessions WHERE id = ? AND expires_at > ?',
    [String(claims.sid), now()],
  );
  if (!session || session.user_id !== claims.sub) throw new OAuthError('invalid_token', 'You’ve been signed out.', 401);

  await run('UPDATE app_sessions SET last_used_at = ? WHERE id = ?', [now(), session.id]);
  res.locals.userId = session.user_id;
  res.locals.appSessionId = session.id;
  res.locals.clientId = session.client_id;
  next();
};

export const endAppSession = (id: string) => run('DELETE FROM app_sessions WHERE id = ?', [id]);

/* The devices list on the Account page --------------------------------------- */

export const listDevices = (userId: string) =>
  all<{ id: string; client_id: string; device_name: string; created_at: string; last_used_at: string }>(
    `SELECT id, client_id, device_name, created_at, last_used_at FROM app_sessions
     WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC`,
    [userId, now()],
  );

export const removeDevice = async (userId: string, id: string) => {
  const result = await run('DELETE FROM app_sessions WHERE id = ? AND user_id = ?', [id, userId]);
  if (!result.rowsAffected) throw new HttpError(404, 'That Mac is already signed out.');
};
