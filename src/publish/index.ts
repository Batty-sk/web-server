import { PUBLISH } from '../config.js';
import { run } from '../db/client.js';
import { buildSite } from './build.js';
import { publishToFilesystem } from './filesystem.js';
import { publishToGitHub } from './github.js';

export interface PublishResult {
  target: 'github' | 'filesystem';
  /** Commit SHA or folder written. */
  reference: string;
  url?: string;
  /** False when the site already matched, so nothing was committed. */
  changed: boolean;
}

export type SiteUpdate = PublishResult & { stories: number };

const publish = async (reason: string): Promise<SiteUpdate> => {
  const build = await buildSite();
  const result =
    PUBLISH.target === 'github'
      ? await publishToGitHub(PUBLISH, build, `newsroom: ${reason}`)
      : await publishToFilesystem(PUBLISH.siteDir, build);

  if (result.changed) {
    await run('INSERT INTO publish_log (reason, target, reference, stories, created_at) VALUES (?, ?, ?, ?, ?)', [
      reason,
      result.target,
      result.reference,
      build.stories,
      new Date().toISOString(),
    ]);
  }
  return { ...result, stories: build.stories };
};

// One update at a time; a save that lands mid-publish queues behind it.
let queue: Promise<unknown> = Promise.resolve();

export const updateSite = (reason: string): Promise<SiteUpdate> => {
  const next = queue.then(() => publish(reason), () => publish(reason));
  queue = next.catch(() => undefined);
  return next;
};
