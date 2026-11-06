import { db } from './client.js';

/**
 * Migrations run in order, once each. Never edit one that has shipped;
 * add a new one instead.
 */
const MIGRATIONS: string[] = [
  // 1 — accounts, admin and the newsroom
  `
  CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    email           TEXT,
    name            TEXT NOT NULL DEFAULT '',
    avatar_url      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_sign_in_at TEXT
  );
  CREATE UNIQUE INDEX users_email ON users (email) WHERE email IS NOT NULL;

  CREATE TABLE user_identities (
    provider    TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'dev')),
    subject     TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    email       TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (provider, subject)
  );

  CREATE TABLE admins (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL DEFAULT '',
    role            TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
    created_at      TEXT NOT NULL,
    last_sign_in_at TEXT
  );

  CREATE TABLE admin_identities (
    provider    TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'dev')),
    subject     TEXT NOT NULL,
    admin_id    TEXT NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (provider, subject)
  );

  CREATE TABLE sessions (
    token_hash    TEXT PRIMARY KEY,
    audience      TEXT NOT NULL CHECK (audience IN ('user', 'admin')),
    principal_id  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    user_agent    TEXT
  );
  CREATE INDEX sessions_principal ON sessions (audience, principal_id);

  CREATE TABLE articles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT    NOT NULL UNIQUE,
    slug_custom   INTEGER NOT NULL DEFAULT 0,
    title         TEXT    NOT NULL DEFAULT '',
    summary       TEXT    NOT NULL DEFAULT '',
    category      TEXT    NOT NULL DEFAULT 'update'
                  CHECK (category IN ('press-release', 'update', 'feature')),
    body          TEXT    NOT NULL DEFAULT '',
    hero_image    TEXT,
    hero_alt      TEXT    NOT NULL DEFAULT '',
    hero_width    INTEGER,
    hero_height   INTEGER,
    featured      INTEGER NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    published_at  TEXT,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL,
    updated_by    TEXT
  );
  CREATE INDEX articles_published ON articles (status, published_at DESC, id DESC);

  -- Uploaded images live here until a story using them is published to the site.
  CREATE TABLE media (
    name        TEXT PRIMARY KEY,
    mime        TEXT NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    bytes       BLOB NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE publish_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reason      TEXT NOT NULL,
    target      TEXT NOT NULL,
    reference   TEXT,
    stories     INTEGER NOT NULL,
    created_at  TEXT NOT NULL
  );
  `,
  // 2 — Manuscript subscriptions, seats and entitlements
  `
  CREATE TABLE billing_customers (
    user_id      TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    customer_id  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    UNIQUE (provider, customer_id)
  );

  -- One row per subscription, wherever it was bought. "web" is billed by
  -- Squircle (Stripe); "app_store" will be billed by Apple.
  CREATE TABLE subscriptions (
    id                        TEXT PRIMARY KEY,
    owner_user_id             TEXT REFERENCES users (id) ON DELETE SET NULL,
    channel                   TEXT NOT NULL CHECK (channel IN ('web', 'app_store')),
    provider                  TEXT NOT NULL,
    provider_subscription_id  TEXT NOT NULL,
    provider_customer_id      TEXT,
    name                      TEXT NOT NULL DEFAULT '',
    status                    TEXT NOT NULL,
    seats                     INTEGER NOT NULL CHECK (seats >= 1),
    current_period_end        TEXT,
    cancel_at_period_end      INTEGER NOT NULL DEFAULT 0,
    ended_at                  TEXT,
    provider_event_at         TEXT,
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    UNIQUE (provider, provider_subscription_id)
  );
  CREATE INDEX subscriptions_owner ON subscriptions (owner_user_id);

  -- A seat is a person's place on a subscription: the buyer's own, or one
  -- they've given to someone by email.
  CREATE TABLE subscription_seats (
    id               TEXT PRIMARY KEY,
    subscription_id  TEXT NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
    user_id          TEXT REFERENCES users (id) ON DELETE CASCADE,
    email            TEXT NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    state            TEXT NOT NULL CHECK (state IN ('invited', 'active')),
    invited_at       TEXT NOT NULL,
    accepted_at      TEXT,
    UNIQUE (subscription_id, email)
  );
  CREATE INDEX seats_user ON subscription_seats (user_id);
  CREATE INDEX seats_email ON subscription_seats (email, state);

  -- Webhook deliveries already handled, so a retried event is applied once.
  CREATE TABLE billing_events (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    received_at  TEXT NOT NULL
  );
  `,
  // 3 — Signing in to the Manuscript apps
  `
  -- One-time codes handed to an app after the person approves it (OAuth + PKCE).
  CREATE TABLE app_auth_codes (
    code_hash       TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    client_id       TEXT NOT NULL,
    redirect_uri    TEXT NOT NULL,
    code_challenge  TEXT NOT NULL,
    device_name     TEXT NOT NULL DEFAULT '',
    expires_at      TEXT NOT NULL
  );

  -- A signed-in Mac. The refresh token rotates on every use; presenting the
  -- previous one means it was copied, and the whole session is revoked.
  CREATE TABLE app_sessions (
    id                     TEXT PRIMARY KEY,
    user_id                TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    client_id              TEXT NOT NULL,
    device_name            TEXT NOT NULL DEFAULT '',
    refresh_hash           TEXT NOT NULL UNIQUE,
    previous_refresh_hash  TEXT,
    created_at             TEXT NOT NULL,
    last_used_at           TEXT NOT NULL,
    expires_at             TEXT NOT NULL
  );
  CREATE INDEX app_sessions_user ON app_sessions (user_id);
  `,
];

export const migrate = async () => {
  await db.execute('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = (await db.execute('SELECT MAX(version) AS v FROM schema_version')).rows[0];
  const current = Number(row?.v ?? 0);

  for (let i = current; i < MIGRATIONS.length; i += 1) {
    await db.executeMultiple(`BEGIN; ${MIGRATIONS[i]} INSERT INTO schema_version (version) VALUES (${i + 1}); COMMIT;`);
  }
  await db.execute('PRAGMA foreign_keys = ON');
};
