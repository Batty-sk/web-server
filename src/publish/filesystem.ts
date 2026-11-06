import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SiteBuild } from './build.js';
import type { PublishResult } from './index.js';

/** Development: writes straight into a local checkout of the website. */
export const publishToFilesystem = async (siteDir: string, build: SiteBuild): Promise<PublishResult> => {
  const root = path.resolve(siteDir);
  const landingPage = path.join(root, 'index.html');
  if (!existsSync(landingPage)) throw new Error(`SITE_DIR (${root}) doesn’t look like the website: index.html is missing.`);

  // Build beside the live folder, then swap, so a reader never sees half a newsroom.
  const stamp = `${Date.now()}-${process.pid}`;
  const staging = path.join(root, `.newsroom-build-${stamp}`);
  const retired = path.join(root, `.newsroom-old-${stamp}`);
  const live = path.join(root, 'newsroom');
  try {
    for (const [relative, contents] of build.newsroom) {
      const target = path.join(staging, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, 'utf8');
    }
    if (existsSync(live)) await rename(live, retired);
    await rename(staging, live);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(retired, { recursive: true, force: true });
  }

  const mediaDir = path.join(root, 'assets', 'newsroom');
  await mkdir(mediaDir, { recursive: true });
  for (const [name, bytes] of build.media) {
    const target = path.join(mediaDir, name);
    if (!existsSync(target)) await writeFile(target, bytes);
  }

  const { html, found } = build.landing(await readFile(landingPage, 'utf8'));
  if (!found) console.warn('newsroom: index.html has no <!-- newsroom:start --> marker.');
  await writeFile(landingPage, html, 'utf8');

  return { target: 'filesystem', reference: root, changed: true };
};
