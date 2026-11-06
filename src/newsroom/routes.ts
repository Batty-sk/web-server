import express, { Router, type Request, type Response } from 'express';

import { API_URL, SITE_URL } from '../config.js';
import { requireAdmin } from '../auth/sessions.js';
import { requireSiteOrigin } from '../http/cors.js';
import { updateSite, type SiteUpdate } from '../publish/index.js';
import {
  createArticle,
  deleteArticle,
  getArticle,
  listArticles,
  listPublished,
  publishArticle,
  unpublishArticle,
  updateArticle,
} from './articles.js';
import { renderMarkdown } from './markdown.js';
import { MAX_UPLOAD_BYTES, saveMedia } from './media.js';
import { renderArticle, storyPath } from './templates.js';
import { HttpError, type Article } from './types.js';
import { parseArticleInput } from './validate.js';

/** Draft images aren't on the website yet, so previews read them from the API. */
const PREVIEW = { base: `${SITE_URL}/`, mediaBase: `${API_URL}/media/` };

const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'That story no longer exists.');
  return id;
};

const editor = (res: Response) => res.locals.adminId as string;

/** Adds the live URL, so the editor can link straight to the published page. */
const present = (article: Article) => ({
  ...article,
  url: article.status === 'published' ? `${SITE_URL}/${storyPath(article)}` : null,
});

const site = (update: SiteUpdate) => ({ changed: update.changed, target: update.target, commitUrl: update.url ?? null });

export const newsroomAdmin = Router();

newsroomAdmin.use(requireAdmin, requireSiteOrigin);

newsroomAdmin.get('/articles', async (_req, res) => {
  res.json({ articles: (await listArticles()).map(present) });
});

newsroomAdmin.post('/articles', async (req, res) => {
  const article = await createArticle(parseArticleInput(req.body ?? {}), editor(res));
  res.status(201).json({ article: present(article) });
});

newsroomAdmin.get('/articles/:id', async (req, res) => {
  res.json({ article: present(await getArticle(idParam(req))) });
});

newsroomAdmin.patch('/articles/:id', async (req, res) => {
  const article = await updateArticle(idParam(req), parseArticleInput(req.body), editor(res));
  // Saving a published story is publishing it.
  const update = article.status === 'published' ? await updateSite(`update “${article.title}”`) : null;
  res.json({ article: present(article), site: update && site(update) });
});

newsroomAdmin.post('/articles/:id/publish', async (req, res) => {
  const article = await publishArticle(idParam(req), editor(res));
  res.json({ article: present(article), site: site(await updateSite(`publish “${article.title}”`)) });
});

newsroomAdmin.post('/articles/:id/unpublish', async (req, res) => {
  const article = await unpublishArticle(idParam(req), editor(res));
  res.json({ article: present(article), site: site(await updateSite(`unpublish “${article.title}”`)) });
});

newsroomAdmin.delete('/articles/:id', async (req, res) => {
  const removed = await deleteArticle(idParam(req));
  if (removed.status === 'published') await updateSite(`remove “${removed.title}”`);
  res.status(204).end();
});

newsroomAdmin.get('/articles/:id/preview', async (req, res) => {
  const article = await getArticle(idParam(req));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.type('html').send(renderArticle(article, await listPublished(), { ...PREVIEW, preview: true }));
});

newsroomAdmin.post('/render', (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body : '';
  res.json({ html: renderMarkdown(body, PREVIEW) });
});

newsroomAdmin.post(
  '/uploads',
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(415, 'Use a JPEG, PNG, WebP or GIF image.');
    const saved = await saveMedia(req.body);
    res.status(201).json({ ...saved, url: `${API_URL}/media/${saved.path.split('/').pop()}` });
  },
);

/** Regenerates every page, after a template change for example. Owners only. */
newsroomAdmin.post('/rebuild', async (_req, res) => {
  if (res.locals.adminRole !== 'owner') throw new HttpError(403, 'Only the owner can rebuild the Newsroom.');
  res.json({ site: site(await updateSite('rebuild')) });
});
