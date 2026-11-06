import { createHash } from 'node:crypto';

import type { SiteBuild } from './build.js';
import type { PublishResult } from './index.js';

interface GitHubConfig {
  token: string;
  repo: string;
  branch: string;
}

interface TreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  sha?: string | null;
  content?: string;
}

class GitHubError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** The SHA git would give these bytes, so unchanged files are left out of the commit. */
const blobSha = (bytes: Buffer) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * Production: publishes the newsroom as one atomic commit on the site's
 * repository, and GitHub Pages deploys it. Readers only ever get static files.
 */
export const publishToGitHub = async (config: GitHubConfig, build: SiteBuild, message: string): Promise<PublishResult> => {
  const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const response = await fetch(`https://api.github.com/repos/${config.repo}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'squircle-server',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) throw new GitHubError(response.status, `GitHub ${init.method ?? 'GET'} ${path} → ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };

  const attempt = async (): Promise<PublishResult> => {
    const ref = await api<{ object: { sha: string } }>(`/git/ref/heads/${config.branch}`);
    const head = ref.object.sha;
    const commit = await api<{ tree: { sha: string } }>(`/git/commits/${head}`);
    const tree = await api<{ tree: { path: string; sha: string; type: string }[]; truncated: boolean }>(
      `/git/trees/${commit.tree.sha}?recursive=1`,
    );
    if (tree.truncated) throw new Error('The site repository is too large to read in one request.');

    const existing = new Map(tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
    const entries: TreeEntry[] = [];

    const putText = (path: string, contents: string) => {
      if (existing.get(path) !== blobSha(Buffer.from(contents, 'utf8'))) {
        entries.push({ path, mode: '100644', type: 'blob', content: contents });
      }
    };

    for (const [relative, contents] of build.newsroom) putText(`newsroom/${relative}`, contents);

    // Anything left in newsroom/ belongs to a story that's no longer published.
    for (const path of existing.keys()) {
      if (path.startsWith('newsroom/') && !build.newsroom.has(path.slice('newsroom/'.length))) {
        entries.push({ path, mode: '100644', type: 'blob', sha: null });
      }
    }

    for (const [name, bytes] of build.media) {
      const path = `assets/newsroom/${name}`;
      if (existing.has(path)) continue;
      const blob = await api<{ sha: string }>('/git/blobs', {
        method: 'POST',
        body: { content: bytes.toString('base64'), encoding: 'base64' },
      });
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const indexSha = existing.get('index.html');
    if (indexSha) {
      const blob = await api<{ content: string }>(`/git/blobs/${indexSha}`);
      const { html, found } = build.landing(Buffer.from(blob.content, 'base64').toString('utf8'));
      if (!found) console.warn('newsroom: index.html has no <!-- newsroom:start --> marker.');
      putText('index.html', html);
    }

    if (!entries.length) return { target: 'github', reference: head, changed: false };

    const newTree = await api<{ sha: string }>('/git/trees', { method: 'POST', body: { base_tree: commit.tree.sha, tree: entries } });
    const newCommit = await api<{ sha: string; html_url: string }>('/git/commits', {
      method: 'POST',
      body: { message, tree: newTree.sha, parents: [head] },
    });
    // Not forced: if someone pushed in the meantime, this fails and we rebuild on top of their work.
    await api(`/git/refs/heads/${config.branch}`, { method: 'PATCH', body: { sha: newCommit.sha, force: false } });

    return { target: 'github', reference: newCommit.sha, url: newCommit.html_url, changed: true };
  };

  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      const raced = error instanceof GitHubError && error.status === 422;
      if (!raced || tries >= 3) throw error;
    }
  }
};
