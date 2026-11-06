import express, { Router, type Request, type Response } from 'express';

import { API_URL } from '../config.js';
import { requireAdmin } from '../auth/sessions.js';
import { requireSiteOrigin } from '../http/cors.js';
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
import { MEDIA, storyPage, storyUrl } from './public.js';
import { HttpError, type Article } from './types.js';
import { parseArticleInput } from './validate.js';

const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'That story no longer exists.');
  return id;
};

const editor = (res: Response) => res.locals.adminId as string;

/** Adds the live URL, so the editor can link straight to the published page. */
const present = (article: Article) => ({
  ...article,
  url: article.status === 'published' ? storyUrl(article.slug) : null,
});

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

// Readers get stories straight from the database, so saving a published story
// is publishing it, and publishing is instant.
newsroomAdmin.patch('/articles/:id', async (req, res) => {
  const article = await updateArticle(idParam(req), parseArticleInput(req.body), editor(res));
  res.json({ article: present(article) });
});

newsroomAdmin.post('/articles/:id/publish', async (req, res) => {
  res.json({ article: present(await publishArticle(idParam(req), editor(res))) });
});

newsroomAdmin.post('/articles/:id/unpublish', async (req, res) => {
  res.json({ article: present(await unpublishArticle(idParam(req), editor(res))) });
});

newsroomAdmin.delete('/articles/:id', async (req, res) => {
  await deleteArticle(idParam(req));
  res.status(204).end();
});

/** The website's story page reads this for a preview, so drafts look exactly as they will live. */
newsroomAdmin.get('/articles/:id/story', async (req, res) => {
  const article = await getArticle(idParam(req));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...storyPage(article, await listPublished()), preview: true });
});

newsroomAdmin.post('/render', (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body : '';
  res.json({ html: renderMarkdown(body, MEDIA) });
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
