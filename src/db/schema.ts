import { db } from './client.js';

/**
 * Migrations run in order, once each, and are remembered by name. Names (not
 * numbers) let features built on separate branches add their own without
 * colliding. Never edit one that has shipped; add a new one instead.
 */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: 'accounts-and-newsroom',
    sql: `
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
  },
  {
    name: 'community-templates',
    sql: `
  -- Templates people share with the Manuscript community. Squircle's own
  -- templates live in the website's catalogue, not here.
  CREATE TABLE templates (
    id             TEXT PRIMARY KEY,
    owner_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title          TEXT NOT NULL DEFAULT '',
    description    TEXT NOT NULL DEFAULT '',
    category       TEXT NOT NULL DEFAULT 'Work' CHECK (category IN ('Work', 'School', 'Writing', 'Personal')),
    tags           TEXT NOT NULL DEFAULT '[]',
    format         TEXT NOT NULL CHECK (format IN ('docx', 'xlsx', 'pptx')),
    -- Pages, sheets or slides, when the file says. (Not "length": libSQL rows already have one.)
    item_count     INTEGER,
    use_placeholder INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'in_review', 'published', 'declined')),
    review_note    TEXT NOT NULL DEFAULT '',
    reviewed_by    TEXT,
    reviewed_at    TEXT,
    submitted_at   TEXT,
    published_at   TEXT,
    downloads      INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX templates_owner ON templates (owner_id, updated_at DESC);
  CREATE INDEX templates_status ON templates (status, published_at DESC);

  -- original: as uploaded, only ever seen by its creator.
  -- placeholder: the original with its words replaced by Lorem Ipsum.
  -- published: what reviewers check and everyone downloads, personal details removed.
  CREATE TABLE template_files (
    template_id  TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('original', 'placeholder', 'published')),
    name         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    bytes        BLOB NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (template_id, kind)
  );

  -- Images the creator adds; the first is the cover. The bytes live in media.
  CREATE TABLE template_previews (
    template_id  TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    media        TEXT NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    PRIMARY KEY (template_id, position)
  );
  `,
  },
];

export const migrate = async () => {
  await db.execute('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');

  // Databases from before named migrations counted them instead. Version 1 was
  // the same everywhere, so carry it over; later numbers belong to other branches.
  const legacy = await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'");
  if (legacy.rows.length) {
    const version = Number((await db.execute('SELECT MAX(version) AS v FROM schema_version')).rows[0]?.v ?? 0);
    if (version >= 1) {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO migrations (name, applied_at) VALUES (?, ?)',
        args: [MIGRATIONS[0]!.name, new Date().toISOString()],
      });
    }
  }

  const applied = new Set((await db.execute('SELECT name FROM migrations')).rows.map((r) => String(r.name)));
  for (const { name, sql } of MIGRATIONS) {
    if (applied.has(name)) continue;
    await db.executeMultiple(
      `BEGIN; ${sql} INSERT INTO migrations (name, applied_at) VALUES ('${name}', '${new Date().toISOString()}'); COMMIT;`,
    );
  }
  await db.execute('PRAGMA foreign_keys = ON');
};
