import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { createClient, type InArgs, type Row } from '@libsql/client';

import { DATABASE } from '../config.js';

if (DATABASE.url.startsWith('file:')) {
  mkdirSync(path.dirname(DATABASE.url.slice('file:'.length)), { recursive: true });
}

/** libSQL: a local SQLite file in development, Turso in production. Same SQL either way. */
export const db = createClient(DATABASE);

export const all = async <T>(sql: string, args: InArgs = []): Promise<T[]> =>
  (await db.execute({ sql, args })).rows as unknown as T[];

export const one = async <T>(sql: string, args: InArgs = []): Promise<T | undefined> =>
  (await all<T>(sql, args))[0];

export const run = async (sql: string, args: InArgs = []) => db.execute({ sql, args });

export type { Row };
