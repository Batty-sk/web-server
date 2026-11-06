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

/** The static website on GitHub Pages. Readers never call this server. */
export const SITE_URL = origin(required('SITE_URL', 'http://localhost:8080'));

/**
 * The public address written into generated pages (canonical URLs, social cards, RSS).
 * Separate from SITE_URL so pages built during local development still point at the real site.
 */
export const CANONICAL_URL = origin(env('CANONICAL_URL') ?? 'https://squircle.london');

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

export const PUBLISH =
  (env('PUBLISH_TARGET') ?? (IS_PRODUCTION ? 'github' : 'filesystem')) === 'github'
    ? {
        target: 'github' as const,
        token: required('GITHUB_TOKEN'),
        repo: required('GITHUB_REPO'),
        branch: env('GITHUB_BRANCH') ?? 'main',
      }
    : { target: 'filesystem' as const, siteDir: required('SITE_DIR', '../manuscript') };

export const SESSION_TTL = {
  user: 30 * 24 * 60 * 60 * 1000,
  admin: 12 * 60 * 60 * 1000,
} as const;

/* Manuscript subscription ------------------------------------------------ */

/**
 * One product, one price, per person. Students, freelancers and companies all
 * pay the same; organisations simply buy more seats. Stripe's price must match.
 */
export const PLAN = {
  product: 'Manuscript',
  amount: 999,
  currency: 'usd',
  interval: 'month',
  maxSeats: 500,
} as const;

export const BILLING =
  (env('BILLING_PROVIDER') ?? (IS_PRODUCTION ? 'stripe' : 'dev')) === 'stripe'
    ? {
        provider: 'stripe' as const,
        secretKey: required('STRIPE_SECRET_KEY'),
        webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
        priceId: required('STRIPE_PRICE_ID'),
        automaticTax: env('STRIPE_AUTOMATIC_TAX') === 'true',
      }
    : (() => {
        if (IS_PRODUCTION) throw new Error('BILLING_PROVIDER=dev is for local development only.');
        return { provider: 'dev' as const };
      })();

/* Apps (the Manuscript Mac app) ------------------------------------------ */

/**
 * Signs entitlement tokens the apps verify offline. An EC P-256 private key in
 * PKCS#8 PEM; apps trust the matching public key from /app/jwks.json.
 * Development generates a throwaway key at startup.
 */
export const ENTITLEMENT_PRIVATE_KEY = IS_PRODUCTION
  ? required('ENTITLEMENT_PRIVATE_KEY').replace(/\\n/g, '\n')
  : env('ENTITLEMENT_PRIVATE_KEY')?.replace(/\\n/g, '\n');

/** Native apps allowed to sign in, and where they may receive the result. */
export const APP_CLIENTS: Record<string, { name: string; redirectUris: string[] }> = {
  'manuscript-mac': { name: 'Manuscript for Mac', redirectUris: ['manuscript://auth/callback'] },
};
