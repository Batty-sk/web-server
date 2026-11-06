import express, { Router, type Request, type Response } from 'express';

import { API_URL, SITE_URL } from '../config.js';
import { requireSiteOrigin } from '../http/cors.js';
import { HttpError } from '../http/errors.js';
import { getAdmin, signInAdmin, signInUser } from './accounts.js';
import { availableProviders, providers, type Provider } from './providers.js';
import { createSession, endSession, readSession } from './sessions.js';
import { sameValue, startPending, takePending } from './state.js';
import type { Audience, ProviderName } from './types.js';

/** Where each audience's flow lives, and where it lands afterwards. */
const AUDIENCES: Record<Audience, { mount: string; home: string }> = {
  user: { mount: '/auth', home: '/account/' },
  admin: { mount: '/admin/auth', home: '/admin/' },
};

/** Only paths on the website; never another host. */
const safeReturnTo = (value: unknown, fallback: string) =>
  typeof value === 'string' && /^\/(?![/\\])[\w\-./?=&#%]*$/.test(value) ? value : fallback;

const siteUrl = (path: string, params: Record<string, string> = {}) => {
  const url = new URL(path, SITE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};

const getProvider = (req: Request): [ProviderName, Provider] => {
  const name = req.params.provider as ProviderName;
  const provider = providers[name];
  if (!provider) throw new HttpError(404, 'That sign-in method isn’t available.');
  return [name, provider];
};

/** Apple and Google report cancellation differently; both mean the person chose not to continue. */
const CANCELLED = new Set(['access_denied', 'user_cancelled_authorize']);

export const authRouter = (audience: Audience) => {
  const { mount, home } = AUDIENCES[audience];
  const redirectUri = (provider: ProviderName) => `${API_URL}${mount}/${provider}/callback`;
  const router = Router();

  // Fixed paths come before /:provider so they aren't mistaken for a provider name.

  /** Which buttons the sign-in page should show. */
  router.get('/providers', (_req, res) => {
    res.json({ providers: availableProviders() });
  });

  /** Who's signed in. Pages call this once, on load. */
  router.get('/session', async (req, res) => {
    const id = await readSession(req, res, audience);
    if (!id) return void res.json({ signedIn: false, providers: availableProviders() });
    if (audience === 'admin') {
      const admin = await getAdmin(id);
      return void res.json({ signedIn: Boolean(admin), admin, providers: availableProviders() });
    }
    res.json({ signedIn: true, providers: availableProviders() });
  });

  router.post('/sign-out', requireSiteOrigin, async (req, res) => {
    await endSession(req, res, audience);
    res.status(204).end();
  });

  /** Step 1 — a top-level navigation from the website's Continue button. */
  router.get('/:provider', (req, res) => {
    const [name, provider] = getProvider(req);
    const pending = startPending(res, mount, { provider: name, audience, returnTo: safeReturnTo(req.query.returnTo, home) });
    const extra = Object.fromEntries(
      ['email', 'name'].flatMap((k) => (typeof req.query[k] === 'string' ? [[k, req.query[k] as string]] : [])),
    );
    res.redirect(303, provider.authorizeUrl(pending, redirectUri(name), extra));
  });

  /** Step 2 — the provider sends the person back here. */
  const callback = async (req: Request, res: Response) => {
    const params = (req.method === 'POST' ? req.body : req.query) as Record<string, unknown>;
    const pending = takePending(req, res, mount);
    const fail = (error: string) => res.redirect(303, siteUrl(home, { error }));

    if (typeof params.error === 'string') return fail(CANCELLED.has(params.error) ? 'cancelled' : 'failed');
    if (!pending) return fail('expired');

    const [name, provider] = getProvider(req);
    if (pending.provider !== name || pending.audience !== audience) return fail('failed');
    if (typeof params.state !== 'string' || !sameValue(params.state, pending.state)) return fail('failed');
    if (typeof params.code !== 'string') return fail('failed');

    let profile;
    try {
      profile = await provider.exchange(
        { code: params.code, appleUser: typeof params.user === 'string' ? params.user : undefined },
        pending,
        redirectUri(name),
      );
    } catch (error) {
      console.error(`${name} sign-in failed`, error);
      return fail('failed');
    }

    if (audience === 'admin') {
      const adminId = await signInAdmin(profile);
      if (!adminId) return fail('not-authorized');
      await createSession(req, res, 'admin', adminId);
    } else {
      const userId = await signInUser(profile);
      await createSession(req, res, 'user', userId);
    }

    res.redirect(303, siteUrl(pending.returnTo));
  };

  router.get('/:provider/callback', callback);
  // Apple's form post arrives cross-site and without an Origin we can check; the signed state cookie is the proof.
  router.post('/:provider/callback', express.urlencoded({ extended: false, limit: '10kb' }), callback);

  return router;
};
