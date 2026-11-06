import express from 'express';

import { authRouter } from './auth/routes.js';
import { IS_PRODUCTION } from './config.js';
import { cors } from './http/cors.js';
import { errorHandler, HttpError } from './http/errors.js';
import { getMedia } from './newsroom/media.js';
import { newsroomPublic } from './newsroom/public.js';
import { newsroomAdmin } from './newsroom/routes.js';
import { myTemplates, publicTemplates, templateReview } from './templates/routes.js';
import { meRouter } from './users/routes.js';

export const app = express();

app.disable('x-powered-by');
// Render terminates TLS in front of us; trust it for the client's address and protocol.
if (IS_PRODUCTION) app.set('trust proxy', 1);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(cors);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

/* Accounts — the website's Sign In ------------------------------------- */

app.use('/auth', authRouter('user'));
// Before /me, which parses JSON for everything under it; uploads arrive as raw bytes.
app.use('/me/templates', myTemplates);
app.use('/me', express.json({ limit: '10kb' }), meRouter);

/* Admin — a separate door, by invitation ------------------------------- */

app.use('/admin/auth', authRouter('admin'));
app.use('/admin/newsroom', express.json({ limit: '1mb' }), newsroomAdmin);
app.use('/admin/templates', express.json({ limit: '10kb' }), templateReview);

/* Community templates — public ------------------------------------------ */

app.use('/templates', publicTemplates);

/* The Newsroom — public, read by the website's Newsroom pages ---------- */

app.use('/newsroom', newsroomPublic);

app.get('/media/:name', async (req, res) => {
  if (!/^[a-f0-9]{16}\.(?:jpg|png|webp|gif)$/.test(req.params.name)) throw new HttpError(404, 'Not found.');
  const file = await getMedia(req.params.name);
  if (!file) throw new HttpError(404, 'Not found.');
  // Names are content hashes, so the bytes behind a name never change. Newsroom
  // images are public, so feed readers on other sites may show them too.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.type(file.mime).send(file.bytes);
});

app.use((req, _res, next) => next(new HttpError(404, `Nothing at ${req.path}.`)));
app.use(errorHandler);
