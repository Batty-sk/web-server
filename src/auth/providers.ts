import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose';

import { APPLE, DEV_SIGN_IN, GOOGLE } from '../config.js';
import { HttpError } from '../http/errors.js';
import { pkceChallenge, type PendingSignIn } from './state.js';
import type { Profile, ProviderName } from './types.js';

export interface CallbackInput {
  code: string;
  /** Apple posts the person's name, once, on their first sign-in. */
  appleUser?: string;
}

export interface Provider {
  authorizeUrl(pending: PendingSignIn, redirectUri: string, extra: Record<string, string>): string;
  exchange(input: CallbackInput, pending: PendingSignIn, redirectUri: string): Promise<Profile>;
  /** Apple returns with a form POST; Google and dev with a GET. */
  callbackMethod: 'get' | 'post';
}

const tokenRequest = async (url: string, body: Record<string, string>) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body),
  });
  const data = (await response.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!response.ok || !data.id_token) {
    console.error('Token exchange failed', url, response.status, data.error);
    throw new HttpError(502, 'The sign-in couldn’t be completed.');
  }
  return data.id_token;
};

const isTrue = (value: unknown) => value === true || value === 'true';

/* Google ------------------------------------------------------------------ */

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const google = (config: NonNullable<typeof GOOGLE>): Provider => ({
  callbackMethod: 'get',

  authorizeUrl(pending, redirectUri) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: pkceChallenge(pending.verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  },

  async exchange({ code }, pending, redirectUri) {
    const idToken = await tokenRequest('https://oauth2.googleapis.com/token', {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: pending.verifier,
    });

    const { payload } = await jwtVerify(idToken, googleKeys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: config.clientId,
    });
    if (payload.nonce !== pending.nonce) throw new HttpError(400, 'The sign-in couldn’t be verified.');

    return {
      provider: 'google',
      subject: String(payload.sub),
      email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
      emailVerified: isTrue(payload.email_verified),
      name: typeof payload.name === 'string' ? payload.name : '',
      avatarUrl: typeof payload.picture === 'string' ? payload.picture : null,
    };
  },
});

/* Apple ------------------------------------------------------------------- */

const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

const apple = (config: NonNullable<typeof APPLE>): Provider => {
  // Apple's client secret is a JWT we sign with the .p8 key. It may live up to six months; we make a fresh one daily.
  let cached: { secret: string; expires: number } | null = null;
  const clientSecret = async () => {
    if (cached && cached.expires > Date.now() + 60_000) return cached.secret;
    const key = await importPKCS8(config.privateKey, 'ES256');
    const expires = Date.now() + 24 * 60 * 60 * 1000;
    const secret = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
      .setIssuer(config.teamId)
      .setSubject(config.servicesId)
      .setAudience('https://appleid.apple.com')
      .setIssuedAt()
      .setExpirationTime(Math.floor(expires / 1000))
      .sign(key);
    cached = { secret, expires };
    return secret;
  };

  return {
    callbackMethod: 'post',

    authorizeUrl(pending, redirectUri) {
      const url = new URL('https://appleid.apple.com/auth/authorize');
      url.search = new URLSearchParams({
        client_id: config.servicesId,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'form_post',
        scope: 'name email',
        state: pending.state,
        nonce: pending.nonce,
      }).toString();
      return url.toString();
    },

    async exchange({ code, appleUser }, pending, redirectUri) {
      const idToken = await tokenRequest('https://appleid.apple.com/auth/token', {
        code,
        client_id: config.servicesId,
        client_secret: await clientSecret(),
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });

      const { payload } = await jwtVerify(idToken, appleKeys, {
        issuer: 'https://appleid.apple.com',
        audience: config.servicesId,
      });
      if (payload.nonce !== pending.nonce) throw new HttpError(400, 'The sign-in couldn’t be verified.');

      let name = '';
      try {
        const parsed = appleUser ? (JSON.parse(appleUser) as { name?: { firstName?: string; lastName?: string } }) : null;
        name = [parsed?.name?.firstName, parsed?.name?.lastName].filter(Boolean).join(' ');
      } catch {
        // The name is a courtesy; sign-in doesn't depend on it.
      }

      return {
        provider: 'apple',
        subject: String(payload.sub),
        // May be a private relay address (…@privaterelay.appleid.com). It's still the person's verified email.
        email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
        emailVerified: isTrue(payload.email_verified),
        name,
        avatarUrl: null,
      };
    },
  };
};

/* Development ------------------------------------------------------------- */

/** Skips the provider entirely. Only exists when DEV_SIGN_IN=true outside production. */
const dev: Provider = {
  callbackMethod: 'get',
  authorizeUrl(pending, redirectUri, extra) {
    const url = new URL(redirectUri);
    const code = Buffer.from(JSON.stringify({ email: extra.email ?? 'dev@example.com', name: extra.name ?? 'Dev User' })).toString('base64url');
    url.search = new URLSearchParams({ code, state: pending.state }).toString();
    return url.toString();
  },
  async exchange({ code }) {
    const { email, name } = JSON.parse(Buffer.from(code, 'base64url').toString()) as { email: string; name: string };
    return { provider: 'dev', subject: `dev:${email}`, email: email.toLowerCase(), emailVerified: true, name, avatarUrl: null };
  },
};

export const providers: Partial<Record<ProviderName, Provider>> = {
  ...(APPLE ? { apple: apple(APPLE) } : {}),
  ...(GOOGLE ? { google: google(GOOGLE) } : {}),
  ...(DEV_SIGN_IN ? { dev } : {}),
};

export const availableProviders = () => Object.keys(providers) as ProviderName[];
