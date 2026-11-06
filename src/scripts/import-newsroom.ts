/**
 * Copies Newsroom stories (and their images) from a local SQLite file into
 * DATABASE_URL — for example, from your development database into Turso.
 * Stories whose URL already exists are skipped, so it's safe to run twice.
 *
 *   DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… npm run newsroom:import -- data/dev.db
 *
 * Also reads the older newsroom-cms format, with its images in a site checkout:
 *   npm run newsroom:import -- path/to/newsroom.db path/to/site
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { one, run } from '../db/client.js';
import { migrate } from '../db/schema.js';
import { referencedMedia, saveMedia } from '../newsroom/media.js';

const [sourcePath, siteDir] = process.argv.slice(2);
if (!sourcePath) {
  console.error('Usage: npm run newsroom:import -- <source.db> [site-dir]');
  process.exit(1);
}

await migrate();
const source = new DatabaseSync(sourcePath, { readOnly: true });
const hasMedia = Boolean(source.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media'`).get());
const rows = source.prepare('SELECT * FROM articles ORDER BY id').all() as Record<string, string | number | null>[];

const imageBytes = async (name: string): Promise<Buffer> => {
  if (hasMedia) {
    const row = source.prepare('SELECT bytes FROM media WHERE name = ?').get(name) as { bytes: Uint8Array } | undefined;
    if (row) return Buffer.from(row.bytes);
  }
  if (!siteDir) throw new Error(`Image ${name} isn’t in the source database; pass the site folder too.`);
  return readFile(path.join(siteDir, 'assets', 'newsroom', name));
};

const COLUMNS = ['slug', 'slug_custom', 'title', 'summary', 'category', 'body', 'hero_image', 'hero_alt', 'hero_width',
  'hero_height', 'featured', 'status', 'published_at', 'created_at', 'updated_at'];

let imported = 0;
for (const row of rows) {
  if (await one('SELECT 1 FROM articles WHERE slug = ?', [row.slug as string])) continue;

  for (const name of referencedMedia([{ heroImage: row.hero_image as string | null, body: row.body as string }])) {
    await saveMedia(await imageBytes(name));
  }

  await run(
    `INSERT INTO articles (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
    COLUMNS.map((k) => row[k] ?? null),
  );
  imported += 1;
}

console.log(`Imported ${imported} of ${rows.length} stories.`);
