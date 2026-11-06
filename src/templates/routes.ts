import express, { Router, type Request, type Response } from 'express';

import { getUser } from '../auth/accounts.js';
import { requireAdmin, requireUser } from '../auth/sessions.js';
import { API_URL } from '../config.js';
import { requireSiteOrigin } from '../http/cors.js';
import { HttpError } from '../http/errors.js';
import { MAX_UPLOAD_BYTES, saveMedia } from '../newsroom/media.js';
import { MAX_FILE_BYTES, MIME, sample } from './office.js';
import {
  CATEGORIES,
  LIMITS,
  addPreview,
  approveTemplate,
  countDownload,
  createTemplate,
  creatorNames,
  declineTemplate,
  deleteTemplate,
  filesFor,
  getFile,
  getOwnTemplate,
  getTemplate,
  listByStatus,
  listOwnTemplates,
  makeCover,
  previewsFor,
  removePreview,
  submitTemplate,
  updateTemplate,
  withdrawTemplate,
  type FileKind,
  type Preview,
  type Status,
  type Template,
  type TemplateInput,
} from './store.js';

/* --------------------------------------------------------------------------
   Presenting
   -------------------------------------------------------------------------- */

const previewJson = (p: Preview) => ({ position: p.position, url: `${API_URL}/media/${p.media}`, width: p.width, height: p.height });

/** What anyone may see: the gallery card and its sheet. */
const publicJson = (t: Template, previews: Preview[], creator: string) => ({
  id: t.id,
  title: t.title,
  description: t.description,
  category: t.category,
  tags: t.tags,
  format: t.format,
  length: t.length,
  creator,
  downloads: t.downloads,
  publishedAt: t.publishedAt,
  previews: previews.map(previewJson),
  downloadUrl: `${API_URL}/templates/${t.id}/download`,
});

/** What the creator sees: everything about their own template. */
const ownJson = async (t: Template) => ({
  ...t,
  ownerId: undefined,
  previews: ((await previewsFor([t.id])).get(t.id) ?? []).map(previewJson),
  files: await filesFor(t.id),
});

/* --------------------------------------------------------------------------
   Input
   -------------------------------------------------------------------------- */

const tidy = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : undefined);

const parseInput = (raw: Record<string, unknown>): TemplateInput => {
  const input: TemplateInput = {};

  if ('title' in raw) {
    input.title = tidy(raw.title) ?? '';
    if (input.title.length > LIMITS.title) throw new HttpError(400, `Keep the title under ${LIMITS.title} characters.`, 'title');
  }
  if ('description' in raw) {
    input.description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (input.description.length > LIMITS.description) {
      throw new HttpError(400, `Keep the description under ${LIMITS.description} characters.`, 'description');
    }
  }
  if ('category' in raw) {
    if (!CATEGORIES.includes(raw.category as never)) throw new HttpError(400, 'Choose a category.', 'category');
    input.category = raw.category as TemplateInput['category'];
  }
  if ('tags' in raw) {
    if (!Array.isArray(raw.tags)) throw new HttpError(400, 'Tags must be a list.', 'tags');
    const tags = [...new Set(raw.tags.map((t) => (tidy(t) ?? '').toLowerCase()).filter(Boolean))];
    if (tags.length > LIMITS.tags) throw new HttpError(400, `Add up to ${LIMITS.tags} tags.`, 'tags');
    if (tags.some((t) => t.length > LIMITS.tag)) throw new HttpError(400, `Keep each tag under ${LIMITS.tag} characters.`, 'tags');
    input.tags = tags;
  }
  if ('usePlaceholder' in raw) input.usePlaceholder = raw.usePlaceholder === true;

  return input;
};

const sendFile = (res: Response, file: { name: string; bytes: Buffer }, format: Template['format']) => {
  res.setHeader('Content-Type', MIME[format]);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file.bytes);
};

const images = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: MAX_UPLOAD_BYTES });

/* --------------------------------------------------------------------------
   /me/templates — your own templates
   -------------------------------------------------------------------------- */

export const myTemplates = Router();

myTemplates.use(requireUser, requireSiteOrigin);

const userId = (res: Response) => res.locals.userId as string;
const own = (req: Request, res: Response) => getOwnTemplate(String(req.params.id), userId(res));

myTemplates.get('/', async (_req, res) => {
  const templates = await listOwnTemplates(userId(res));
  res.json({ templates: await Promise.all(templates.map(ownJson)), limits: LIMITS, categories: CATEGORIES });
});

/** The file is the body; its name comes in ?name= so no custom header is needed. */
myTemplates.post('/', express.raw({ type: () => true, limit: MAX_FILE_BYTES }), async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Choose a file to upload.');
  const name = (typeof req.query.name === 'string' ? req.query.name : 'Template').slice(0, 200);
  const template = await createTemplate(userId(res), name, req.body);
  res.status(201).json({ template: await ownJson(template) });
});

myTemplates.get('/:id', async (req, res) => {
  res.json({ template: await ownJson(await own(req, res)) });
});

myTemplates.patch('/:id', express.json({ limit: '20kb' }), async (req, res) => {
  const template = await updateTemplate(await own(req, res), parseInput(req.body ?? {}));
  res.json({ template: await ownJson(template) });
});

/** The first paragraphs of the original and the placeholder version, side by side. */
myTemplates.get('/:id/placeholder-sample', async (req, res) => {
  const template = await own(req, res);
  const [original, replaced] = await Promise.all([getFile(template.id, 'original'), getFile(template.id, 'placeholder')]);
  if (!original || !replaced) throw new HttpError(404, 'Turn on placeholder text first.');
  res.json({ original: sample(original.bytes, template.format), placeholder: sample(replaced.bytes, template.format) });
});

myTemplates.get('/:id/files/:kind', async (req, res) => {
  const template = await own(req, res);
  const kind = req.params.kind as FileKind;
  if (!['original', 'placeholder', 'published'].includes(kind)) throw new HttpError(404, 'Not found.');
  const file = await getFile(template.id, kind);
  if (!file) throw new HttpError(404, 'That version hasn’t been made yet.');
  sendFile(res, file, template.format);
});

myTemplates.post('/:id/previews', images, async (req, res) => {
  const template = await own(req, res);
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(415, 'Use a JPEG, PNG, WebP or GIF image.');
  const image = await saveMedia(req.body);
  if (image.width < 600) throw new HttpError(422, 'Use an image at least 600 pixels wide, so it looks sharp in the gallery.');
  await addPreview(template, image);
  res.status(201).json({ template: await ownJson(await getTemplate(template.id)) });
});

myTemplates.post('/:id/previews/:position/cover', async (req, res) => {
  const template = await own(req, res);
  await makeCover(template, Number(req.params.position));
  res.json({ template: await ownJson(template) });
});

myTemplates.delete('/:id/previews/:position', async (req, res) => {
  const template = await own(req, res);
  await removePreview(template, Number(req.params.position));
  res.json({ template: await ownJson(template) });
});

/** Sends it for review. The creator confirms the template is theirs to share. */
myTemplates.post('/:id/submit', express.json({ limit: '1kb' }), async (req, res) => {
  if (req.body?.confirm !== true) {
    throw new HttpError(422, 'Confirm that you made this template, or have the right to share it.', 'confirm');
  }
  res.json({ template: await ownJson(await submitTemplate(await own(req, res))) });
});

myTemplates.post('/:id/withdraw', async (req, res) => {
  res.json({ template: await ownJson(await withdrawTemplate(await own(req, res))) });
});

myTemplates.delete('/:id', async (req, res) => {
  await deleteTemplate((await own(req, res)).id);
  res.status(204).end();
});

/* --------------------------------------------------------------------------
   /templates — the community gallery, public
   -------------------------------------------------------------------------- */

export const publicTemplates = Router();

publicTemplates.get('/', async (_req, res) => {
  const templates = await listByStatus('published');
  const [previews, names] = await Promise.all([
    previewsFor(templates.map((t) => t.id)),
    creatorNames([...new Set(templates.map((t) => t.ownerId))]),
  ]);
  res.setHeader('Cache-Control', 'public, no-cache');
  res.json({
    templates: templates.map((t) => publicJson(t, previews.get(t.id) ?? [], names.get(t.ownerId) ?? 'A Squircle Labs member')),
  });
});

publicTemplates.get('/:id/download', async (req, res) => {
  const template = await getTemplate(String(req.params.id)).catch(() => null);
  if (!template || template.status !== 'published') throw new HttpError(404, 'That template isn’t available.');
  const file = await getFile(template.id, 'published');
  if (!file) throw new HttpError(404, 'That template isn’t available.');
  await countDownload(template.id);
  sendFile(res, file, template.format);
});

/* --------------------------------------------------------------------------
   /admin/templates — review
   -------------------------------------------------------------------------- */

export const templateReview = Router();

templateReview.use(requireAdmin, requireSiteOrigin);

const STATUSES: Status[] = ['in_review', 'published', 'declined'];

templateReview.get('/', async (req, res) => {
  const status = (STATUSES.includes(req.query.status as Status) ? req.query.status : 'in_review') as Status;
  const templates = await listByStatus(status);
  const previews = await previewsFor(templates.map((t) => t.id));
  const owners = new Map(
    await Promise.all([...new Set(templates.map((t) => t.ownerId))].map(async (id) => [id, await getUser(id)] as const)),
  );
  res.json({
    templates: await Promise.all(
      templates.map(async (t) => ({
        ...t,
        ownerId: undefined,
        creator: { name: owners.get(t.ownerId)?.name || '', email: owners.get(t.ownerId)?.email || '' },
        previews: (previews.get(t.id) ?? []).map(previewJson),
        file: (await filesFor(t.id)).published ?? null,
      })),
    ),
  });
});

/** Reviewers check the exact file that will be published. */
templateReview.get('/:id/file', async (req, res) => {
  const template = await getTemplate(String(req.params.id));
  const file = await getFile(template.id, 'published');
  if (!file) throw new HttpError(404, 'This template hasn’t been submitted.');
  sendFile(res, file, template.format);
});

templateReview.post('/:id/approve', async (req, res) => {
  const template = await approveTemplate(await getTemplate(String(req.params.id)), res.locals.adminId as string);
  res.json({ template: { ...template, ownerId: undefined } });
});

templateReview.post('/:id/decline', async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note : '';
  const template = await declineTemplate(await getTemplate(String(req.params.id)), res.locals.adminId as string, note);
  res.json({ template: { ...template, ownerId: undefined } });
});
