import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';

import { SignJWT } from 'jose';

import { getUser } from '../auth/accounts.js';
import { clearCookie, readCookie, setCookie } from '../auth/cookies.js';
import { readSession, requireUser } from '../auth/sessions.js';
import { entitlementFor } from '../billing/subscriptions.js';
import { API_URL, APP_CLIENTS, PLAN, SESSION_SECRET, SITE_URL } from '../config.js';
import { requireSiteOrigin } from '../http/cors.js';
import { HttpError } from '../http/errors.js';
import { entitlementKey } from './keys.js';
import {
  endAppSession,
  issueCode,
  listDevices,
  OAuthError,
  redeemCode,
  refreshAppSession,
  removeDevice,
  requireApp,
} from './sessions.js';

/* The request an app is making, carried through sign-in in a signed cookie ----- */

interface PendingApp {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  deviceName: string;
  exp: number;
}

const COOKIE = 'sl_app';
const COOKIE_PATH = '/app';
const PENDING_TTL_MS = 10 * 60 * 1000;
const sign = (payload: string) => createHmac('sha256', SESSION_SECRET).update(`app:${payload}`).digest('base64url');

const savePending = (res: Response, pending: PendingApp) => {
  const payload = Buffer.from(JSON.stringify(pending)).toString('base64url');
  setCookie(res, COOKIE, `${payload}.${sign(payload)}`, { path: COOKIE_PATH, maxAgeMs: PENDING_TTL_MS });
};

const readPending = (req: Request): PendingApp | null => {
  const [payload, signature] = (readCookie(req, COOKIE) ?? '').split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const pending = JSON.parse(Buffer.from(payload, 'base64url').toString()) as PendingApp;
    return pending.exp > Date.now() ? pending : null;
  } catch {
    return null;
  }
};

const appRedirect = (pending: PendingApp, params: Record<string, string>) => {
  const url = new URL(pending.redirectUri);
  for (const [key, value] of Object.entries({ ...params, ...(pending.state ? { state: pending.state } : {}) })) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

const CONSENT_PAGE = `${SITE_URL}/account/authorize/`;

export const appRouter = Router();

/**
 * Step 1 — the app opens this in ASWebAuthenticationSession. Nothing is
 * redirected back to an app we don't recognise, at an address it didn't register.
 */
appRouter.get('/authorize', (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const client = q.client_id ? APP_CLIENTS[q.client_id] : undefined;
  if (!client || !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
    return void res.status(400).type('text').send('This app isn’t allowed to sign in to Squircle Labs.');
  }
  if (q.code_challenge_method !== 'S256' || !/^[\w-]{43,128}$/.test(q.code_challenge ?? '')) {
    return void res.redirect(303, appRedirect({ redirectUri: q.redirect_uri, state: q.state ?? '' } as PendingApp, { error: 'invalid_request' }));
  }

  savePending(res, {
    clientId: q.client_id!,
    redirectUri: q.redirect_uri,
    challenge: q.code_challenge!,
    state: (q.state ?? '').slice(0, 512),
    deviceName: (q.device_name ?? '').slice(0, 80),
    exp: Date.now() + PENDING_TTL_MS,
  });
  res.redirect(303, CONSENT_PAGE);
});

/** Step 2 — the website's consent page asks what's being requested, and by whom. */
appRouter.get('/authorize/request', async (req, res) => {
  const pending = readPending(req);
  if (!pending) throw new HttpError(404, 'This sign-in request has expired. Go back to Manuscript and try again.');
  const userId = await readSession(req, res, 'user');
  const user = userId ? await getUser(userId) : null;
  res.json({
    client: { id: pending.clientId, name: APP_CLIENTS[pending.clientId]?.name ?? pending.clientId },
    deviceName: pending.deviceName,
    user: user && { name: user.name, email: user.email },
  });
});

/** Step 3 — the person presses Continue. A one-time code goes back to the app. */
appRouter.post('/authorize/approve', requireSiteOrigin, express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  const pending = readPending(req);
  if (!pending) return void res.redirect(303, `${CONSENT_PAGE}?error=expired`);
  const userId = await readSession(req, res, 'user');
  if (!userId) return void res.redirect(303, CONSENT_PAGE);

  const code = await issueCode({
    userId,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    challenge: pending.challenge,
    deviceName: pending.deviceName,
  });
  clearCookie(res, COOKIE, COOKIE_PATH);
  res.redirect(303, appRedirect(pending, { code }));
});

appRouter.post('/authorize/deny', requireSiteOrigin, (req, res) => {
  const pending = readPending(req);
  clearCookie(res, COOKIE, COOKIE_PATH);
  res.redirect(303, pending ? appRedirect(pending, { error: 'access_denied' }) : SITE_URL);
});

/** Step 4 — the app trades the code (and later, its refresh token) for tokens. */
appRouter.post('/token', express.json({ limit: '4kb' }), express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '');

  try {
    const clientId = text('client_id');
    if (!APP_CLIENTS[clientId]) throw new OAuthError('invalid_client', 'Unknown app.', 401);

    if (text('grant_type') === 'authorization_code') {
      return void res.json(
        await redeemCode({ code: text('code'), verifier: text('code_verifier'), clientId, redirectUri: text('redirect_uri') }),
      );
    }
    if (text('grant_type') === 'refresh_token') {
      return void res.json(await refreshAppSession(text('refresh_token'), clientId));
    }
    throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    res.status(error.status).json({ error: error.code, error_description: error.message });
  }
});

const OFFLINE_GRACE_S = 7 * 24 * 60 * 60;

/**
 * The app's question: may this person use Manuscript? The answer comes signed,
 * so the app can keep trusting it offline for a week without asking again.
 */
appRouter.get('/entitlement', requireApp, async (_req, res) => {
  const userId = res.locals.userId as string;
  const [user, entitlement, key] = await Promise.all([getUser(userId), entitlementFor(userId), entitlementKey()]);
  const nowS = Math.floor(Date.now() / 1000);
  const periodEndS = entitlement.source?.periodEnd ? Math.floor(new Date(entitlement.source.periodEnd).getTime() / 1000) : null;
  // A subscription that's ending can't be trusted offline past its last day.
  const expires = entitlement.source?.state === 'ending' && periodEndS ? Math.min(nowS + OFFLINE_GRACE_S, periodEndS) : nowS + OFFLINE_GRACE_S;

  const token = await new SignJWT({
    product: PLAN.product.toLowerCase(),
    entitled: entitlement.entitled,
    state: entitlement.source?.state ?? null,
    channel: entitlement.source?.channel ?? null,
    role: entitlement.source?.role ?? null,
    period_end: entitlement.source?.periodEnd ?? null,
  })
    .setProtectedHeader({ alg: 'ES256', kid: key.publicJwk.kid, typ: 'entitlement+jwt' })
    .setIssuer(API_URL)
    .setAudience(res.locals.clientId as string)
    .setSubject(userId)
    .setIssuedAt(nowS)
    .setExpirationTime(expires)
    .sign(key.privateKey);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    entitlement,
    user: user && { id: user.id, name: user.name, email: user.email },
    token,
    refreshAfter: new Date((nowS + 24 * 60 * 60) * 1000).toISOString(),
    manageUrl: `${SITE_URL}/account/`,
    subscribeUrl: `${SITE_URL}/account/subscribe/`,
  });
});

appRouter.post('/sign-out', requireApp, async (_req, res) => {
  await endAppSession(res.locals.appSessionId as string);
  res.status(204).end();
});

/** The public key apps use to check entitlement tokens. Apps should also ship it, for first launch offline. */
appRouter.get('/jwks.json', async (_req, res) => {
  const { publicJwk } = await entitlementKey();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ keys: [publicJwk] });
});

/* /me/devices: the Macs signed in to this account ----------------------------- */

export const devicesRouter = Router();
devicesRouter.use(requireSiteOrigin, requireUser);

devicesRouter.get('/', async (_req, res) => {
  const devices = await listDevices(res.locals.userId as string);
  res.json({
    devices: devices.map((d) => ({
      id: d.id,
      app: APP_CLIENTS[d.client_id]?.name ?? d.client_id,
      name: d.device_name || 'Mac',
      signedInAt: d.created_at,
      lastUsedAt: d.last_used_at,
    })),
  });
});

devicesRouter.delete('/:id', async (req, res) => {
  await removeDevice(res.locals.userId as string, req.params.id);
  res.status(204).end();
});
