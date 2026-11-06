import { randomBytes } from 'node:crypto';

const env = (name: string) => process.env[name]?.trim() || undefined;

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const required = (name: string, fallbackForDev?: string): string => {
  const value = env(name) ?? (IS_PRODUCTION ? undefined : fallbackForDev);
  if (!value) throw new Error(`${name} must be set${IS_PRODUCTION ? ' in production' : ''}. See .env.example.`);
  return value;
};

const origin = (value: string) => new URL(value).origin;

export const PORT = Number(env('PORT') ?? 4000);

/** The static website on GitHub Pages. Its Newsroom pages read stories from this server. */
export const SITE_URL = origin(required('SITE_URL', 'http://localhost:8080'));

/** This server's public origin, used to build OAuth redirect URIs. */
export const API_URL = origin(required('API_URL', `http://localhost:${PORT}`));

/** Pages allowed to call the API with credentials. */
export const ALLOWED_ORIGINS = new Set(
  [SITE_URL, ...(env('EXTRA_ORIGINS')?.split(',') ?? [])].map((o) => origin(o.trim())),
);

export const DATABASE = {
  url: required('DATABASE_URL', 'file:data/dev.db'),
  authToken: env('DATABASE_AUTH_TOKEN'),
};

/** Signs the short-lived cookie that carries OAuth state between the redirect and the callback. */
export const SESSION_SECRET = required('SESSION_SECRET', randomBytes(32).toString('hex'));

/** Granted the owner role the first time they sign in to Admin. */
export const OWNER_EMAIL = env('OWNER_EMAIL')?.toLowerCase();

export const GOOGLE = env('GOOGLE_CLIENT_ID')
  ? { clientId: required('GOOGLE_CLIENT_ID'), clientSecret: required('GOOGLE_CLIENT_SECRET') }
  : null;

export const APPLE = env('APPLE_SERVICES_ID')
  ? {
      teamId: required('APPLE_TEAM_ID'),
      servicesId: required('APPLE_SERVICES_ID'),
      keyId: required('APPLE_KEY_ID'),
      // Hosting dashboards flatten newlines; accept the key either way.
      privateKey: required('APPLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    }
  : null;

/** Signs in without a provider, for local development only. */
export const DEV_SIGN_IN = !IS_PRODUCTION && env('DEV_SIGN_IN') === 'true';

export const SESSION_TTL = {
  user: 30 * 24 * 60 * 60 * 1000,
  admin: 12 * 60 * 60 * 1000,
} as const;
