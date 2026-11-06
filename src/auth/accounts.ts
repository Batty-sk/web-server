import { randomUUID } from 'node:crypto';

import { OWNER_EMAIL } from '../config.js';
import { db, one, run } from '../db/client.js';
import { deleteTemplatesOf } from '../templates/store.js';
import type { Profile } from './types.js';

const now = () => new Date().toISOString();

export interface User {
  id: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
  createdAt: string;
  providers: string[];
}

export const getUser = async (id: string): Promise<User | null> => {
  const row = await one<{ id: string; email: string | null; name: string; avatar_url: string | null; created_at: string }>(
    'SELECT * FROM users WHERE id = ?',
    [id],
  );
  if (!row) return null;
  const identities = await db.execute({ sql: 'SELECT provider FROM user_identities WHERE user_id = ? ORDER BY created_at', args: [id] });
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    providers: identities.rows.map((r) => String(r.provider)),
  };
};

/**
 * Signing up and signing in are the same act. A returning identity signs in;
 * a new identity with a verified email that matches an account joins it;
 * otherwise a new account is created.
 */
export const signInUser = async (profile: Profile): Promise<string> => {
  const known = await one<{ user_id: string }>('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?', [
    profile.provider,
    profile.subject,
  ]);

  let userId = known?.user_id;

  if (!userId && profile.email && profile.emailVerified) {
    userId = (await one<{ id: string }>('SELECT id FROM users WHERE email = ?', [profile.email]))?.id;
  }

  const timestamp = now();

  if (!userId) {
    userId = randomUUID();
    await run('INSERT INTO users (id, email, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      userId,
      profile.emailVerified ? profile.email : null,
      profile.name,
      profile.avatarUrl,
      timestamp,
      timestamp,
    ]);
  }

  if (!known) {
    await run('INSERT INTO user_identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)', [
      profile.provider,
      profile.subject,
      userId,
      profile.email,
      timestamp,
    ]);
  }

  // Fill gaps only: a name someone set themselves is never overwritten by a provider.
  await run(
    `UPDATE users SET
       name = CASE WHEN name = '' THEN ? ELSE name END,
       avatar_url = COALESCE(avatar_url, ?),
       last_sign_in_at = ?
     WHERE id = ?`,
    [profile.name, profile.avatarUrl, timestamp, userId],
  );

  return userId;
};

export const updateUserName = (id: string, name: string) =>
  run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', [name, now(), id]);

export const deleteUser = async (id: string) => {
  // Their templates go with them, published or not.
  await deleteTemplatesOf(id);
  await run('DELETE FROM sessions WHERE audience = ? AND principal_id = ?', ['user', id]);
  await run('DELETE FROM user_identities WHERE user_id = ?', [id]);
  await run('DELETE FROM users WHERE id = ?', [id]);
};

/* Admin ------------------------------------------------------------------- */

export interface Admin {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'editor';
}

/** Admin access is by invitation only: the email must already be on the team. */
export const signInAdmin = async (profile: Profile): Promise<string | null> => {
  const known = await one<{ admin_id: string }>('SELECT admin_id FROM admin_identities WHERE provider = ? AND subject = ?', [
    profile.provider,
    profile.subject,
  ]);
  let adminId = known?.admin_id;

  if (!adminId) {
    if (!profile.email || !profile.emailVerified) return null;
    adminId = (await one<{ id: string }>('SELECT id FROM admins WHERE email = ?', [profile.email]))?.id;
    if (!adminId) return null;
    await run('INSERT INTO admin_identities (provider, subject, admin_id, created_at) VALUES (?, ?, ?, ?)', [
      profile.provider,
      profile.subject,
      adminId,
      now(),
    ]);
  }

  await run(`UPDATE admins SET name = CASE WHEN name = '' THEN ? ELSE name END, last_sign_in_at = ? WHERE id = ?`, [
    profile.name,
    now(),
    adminId,
  ]);
  return adminId;
};

export const getAdmin = (id: string) =>
  one<Admin>('SELECT id, email, name, role FROM admins WHERE id = ?', [id]);

export const addAdmin = async (email: string, role: Admin['role'], name = '') => {
  const normalized = email.trim().toLowerCase();
  await run(
    'INSERT INTO admins (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role',
    [randomUUID(), normalized, name, role, now()],
  );
};

/** The owner named in OWNER_EMAIL always has access, so the team can never lock itself out. */
export const ensureOwner = async () => {
  if (OWNER_EMAIL) await addAdmin(OWNER_EMAIL, 'owner');
};
