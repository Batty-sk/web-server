import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';

import { createLocalJWKSet, jwtVerify } from 'jose';

import { API, Browser, SITE, stop } from '../test/harness.js';

after(stop);

const CLIENT = 'manuscript-mac';
const REDIRECT = 'manuscript://auth/callback';

/** What the Mac app does: make a verifier, send its challenge, open the browser. */
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const authorizeUrl = (challenge: string, extra: Record<string, string> = {}) =>
  `/app/authorize?${new URLSearchParams({
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    device_name: 'Ann’s MacBook Pro',
    ...extra,
  })}`;

const token = async (body: Record<string, string>) => {
  const response = await fetch(`${API}/app/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT, ...body }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

const entitlement = async (accessToken: string) => {
  const response = await fetch(`${API}/app/entitlement`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

/** The whole sign-in: the browser part on the website, then the app's token exchange. */
const signInToApp = async (browser: Browser) => {
  const { verifier, challenge } = pkce();
  const start = await browser.fetch(authorizeUrl(challenge));
  assert.equal(start.headers.get('location'), `${SITE}/account/authorize/`);
  const approve = await browser.fetch('/app/authorize/approve', { method: 'POST' });
  const callback = new URL(approve.headers.get('location')!);
  return { callback, verifier };
};

describe('signing in to the Mac app', () => {
  const ann = new Browser();
  let tokens: Record<string, any> = {};

  test('unknown apps and unregistered return addresses are refused outright', async () => {
    const { challenge } = pkce();
    assert.equal((await ann.fetch(authorizeUrl(challenge, { client_id: 'evil-app' }))).status, 400);
    const hijack = await ann.fetch(authorizeUrl(challenge, { redirect_uri: 'https://evil.example/steal' }));
    assert.equal(hijack.status, 400);
    assert.equal(hijack.headers.get('location'), null);
  });

  test('the consent page learns which app is asking', async () => {
    await ann.signIn('ann.app@example.com');
    await ann.fetch(authorizeUrl(pkce().challenge));
    const { status, body } = await ann.json('/app/authorize/request');
    assert.equal(status, 200);
    assert.equal(body.client.name, 'Manuscript for Mac');
    assert.equal(body.deviceName, 'Ann’s MacBook Pro');
    assert.equal(body.user.email, 'ann.app@example.com');
  });

  test('declining sends the app an access_denied', async () => {
    const response = await ann.fetch('/app/authorize/deny', { method: 'POST' });
    const callback = new URL(response.headers.get('location')!);
    assert.equal(callback.searchParams.get('error'), 'access_denied');
    assert.equal(callback.searchParams.get('state'), 'xyz');
  });

  test('approving returns a one-time code to the app, with its state', async () => {
    const { callback, verifier } = await signInToApp(ann);
    assert.equal(`${callback.protocol}//${callback.host}${callback.pathname}`, REDIRECT);
    assert.equal(callback.searchParams.get('state'), 'xyz');

    const code = callback.searchParams.get('code')!;
    const wrongVerifier = await token({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, redirect_uri: REDIRECT });
    assert.equal(wrongVerifier.status, 400);
    assert.equal(wrongVerifier.body.error, 'invalid_grant');

    // The failed attempt used the code up: codes work exactly once.
    const again = await signInToApp(ann);
    const exchanged = await token({
      grant_type: 'authorization_code',
      code: again.callback.searchParams.get('code')!,
      code_verifier: again.verifier,
      redirect_uri: REDIRECT,
    });
    assert.equal(exchanged.status, 200);
    assert.equal(exchanged.body.token_type, 'Bearer');
    tokens = exchanged.body;

    const replay = await token({
      grant_type: 'authorization_code',
      code: again.callback.searchParams.get('code')!,
      code_verifier: again.verifier,
      redirect_uri: REDIRECT,
    });
    assert.equal(replay.status, 400);
    void verifier;
  });

  test('without a subscription, the app is told so — in a token it can verify offline', async () => {
    const { status, body } = await entitlement(tokens.access_token);
    assert.equal(status, 200);
    assert.equal(body.entitlement.entitled, false);
    assert.equal(body.subscribeUrl, `${SITE}/account/subscribe/`);

    const jwks = createLocalJWKSet((await (await fetch(`${API}/app/jwks.json`)).json()) as never);
    const { payload, protectedHeader } = await jwtVerify(body.token, jwks, { issuer: API, audience: CLIENT });
    assert.equal(protectedHeader.alg, 'ES256');
    assert.equal(payload.entitled, false);
    assert.equal(payload.product, 'manuscript');
  });

  test('after subscribing on the website, the app sees access', async () => {
    await ann.subscribe(1);
    const { body } = await entitlement(tokens.access_token);
    assert.equal(body.entitlement.entitled, true);

    const jwks = createLocalJWKSet((await (await fetch(`${API}/app/jwks.json`)).json()) as never);
    const { payload } = await jwtVerify(body.token, jwks, { issuer: API, audience: CLIENT });
    assert.equal(payload.entitled, true);
    assert.equal(payload.state, 'active');
    // Trusted offline for a week, no more.
    assert.ok((payload.exp! - payload.iat!) <= 7 * 24 * 60 * 60);
  });

  test('a forged entitlement token fails verification', async () => {
    const { body } = await entitlement(tokens.access_token);
    const [header, payload, signature] = body.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'someone-else' })).toString('base64url');
    const jwks = createLocalJWKSet((await (await fetch(`${API}/app/jwks.json`)).json()) as never);
    await assert.rejects(jwtVerify(`${header}.${forged}.${signature}`, jwks));
  });

  test('refresh tokens rotate, and replaying an old one signs the Mac out', async () => {
    const first = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refresh_token, tokens.refresh_token);

    // Someone replays the token we just rotated away from.
    const stolen = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(stolen.status, 400);

    // Which ends the session: the newest tokens stop working too.
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token })).status, 400);
    assert.equal((await entitlement(first.body.access_token)).status, 401);
  });

  test('the Account page lists signed-in Macs and can sign one out', async () => {
    const { callback, verifier } = await signInToApp(ann);
    const session = await token({ grant_type: 'authorization_code', code: callback.searchParams.get('code')!, code_verifier: verifier, redirect_uri: REDIRECT });

    const { body } = await ann.json('/me/devices');
    assert.equal(body.devices.length, 1);
    assert.equal(body.devices[0].name, 'Ann’s MacBook Pro');
    assert.equal(body.devices[0].app, 'Manuscript for Mac');

    assert.equal((await ann.json(`/me/devices/${body.devices[0].id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await entitlement(session.body.access_token)).status, 401);
  });

  test('approval requires a site-signed-in person', async () => {
    const stranger = new Browser();
    await stranger.fetch(authorizeUrl(pkce().challenge));
    const response = await stranger.fetch('/app/authorize/approve', { method: 'POST' });
    assert.equal(response.headers.get('location'), `${SITE}/account/authorize/`);
  });

  test('app endpoints reject missing and junk tokens', async () => {
    assert.equal((await fetch(`${API}/app/entitlement`)).status, 401);
    assert.equal((await entitlement('not-a-token')).status, 401);
  });
});
