import { createHash, randomBytes } from 'node:crypto';

import { all, one, run } from '../db/client.js';
import { HttpError } from '../http/errors.js';
import { clean, inspect, placeholder, type Format } from './office.js';

export const CATEGORIES = ['Work', 'School', 'Writing', 'Personal'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Status = 'draft' | 'in_review' | 'published' | 'declined';
export type FileKind = 'original' | 'placeholder' | 'published';

export const LIMITS = { title: 80, description: 500, tags: 6, tag: 24, previews: 4 } as const;

export interface Template {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  category: Category;
  tags: string[];
  format: Format;
  length: number | null;
  usePlaceholder: boolean;
  status: Status;
  reviewNote: string;
  reviewedAt: string | null;
  submittedAt: string | null;
  publishedAt: string | null;
  downloads: number;
  createdAt: string;
  updatedAt: string;
}

export interface Preview {
  position: number;
  media: string;
  width: number;
  height: number;
}

interface Row {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  category: Category;
  tags: string;
  format: Format;
  item_count: number | null;
  use_placeholder: number;
  status: Status;
  review_note: string;
  reviewed_at: string | null;
  submitted_at: string | null;
  published_at: string | null;
  downloads: number;
  created_at: string;
  updated_at: string;
}

const toTemplate = (row: Row): Template => ({
  id: row.id,
  ownerId: row.owner_id,
  title: row.title,
  description: row.description,
  category: row.category,
  tags: JSON.parse(row.tags) as string[],
  format: row.format,
  length: row.item_count === null ? null : Number(row.item_count),
  usePlaceholder: Number(row.use_placeholder) === 1,
  status: row.status,
  reviewNote: row.review_note,
  reviewedAt: row.reviewed_at,
  submittedAt: row.submitted_at,
  publishedAt: row.published_at,
  downloads: Number(row.downloads),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const now = () => new Date().toISOString();

/* --------------------------------------------------------------------------
   Reading
   -------------------------------------------------------------------------- */

export const getTemplate = async (id: string): Promise<Template> => {
  const row = await one<Row>('SELECT * FROM templates WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, 'That template no longer exists.');
  return toTemplate(row);
};

/** Someone else's template looks exactly like a missing one. */
export const getOwnTemplate = async (id: string, ownerId: string) => {
  const template = await getTemplate(id).catch(() => null);
  if (!template || template.ownerId !== ownerId) throw new HttpError(404, 'That template no longer exists.');
  return template;
};

export const listOwnTemplates = async (ownerId: string) =>
  (await all<Row>('SELECT * FROM templates WHERE owner_id = ? ORDER BY updated_at DESC', [ownerId])).map(toTemplate);

export const listByStatus = async (status: Status) =>
  (
    await all<Row>(
      `SELECT * FROM templates WHERE status = ? ORDER BY ${status === 'published' ? 'published_at DESC' : 'COALESCE(submitted_at, updated_at) ASC'}`,
      [status],
    )
  ).map(toTemplate);

export const previewsFor = async (ids: string[]) => {
  const map = new Map<string, Preview[]>(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = await all<Preview & { template_id: string }>(
    `SELECT template_id, position, media, width, height FROM template_previews
     WHERE template_id IN (${ids.map(() => '?').join(',')}) ORDER BY position`,
    ids,
  );
  for (const row of rows) {
    map.get(row.template_id)?.push({ position: Number(row.position), media: row.media, width: Number(row.width), height: Number(row.height) });
  }
  return map;
};

export const filesFor = async (id: string) => {
  const rows = await all<{ kind: FileKind; name: string; size: number }>(
    'SELECT kind, name, size FROM template_files WHERE template_id = ?',
    [id],
  );
  return Object.fromEntries(rows.map((r) => [r.kind, { name: r.name, size: Number(r.size) }])) as Partial<
    Record<FileKind, { name: string; size: number }>
  >;
};

export const getFile = async (id: string, kind: FileKind) => {
  const row = await one<{ name: string; bytes: ArrayBuffer | Uint8Array }>(
    'SELECT name, bytes FROM template_files WHERE template_id = ? AND kind = ?',
    [id, kind],
  );
  return row ? { name: row.name, bytes: Buffer.from(row.bytes as ArrayBuffer) } : null;
};

export const creatorNames = async (ownerIds: string[]) => {
  if (!ownerIds.length) return new Map<string, string>();
  const rows = await all<{ id: string; name: string | null }>(
    `SELECT id, name FROM users WHERE id IN (${ownerIds.map(() => '?').join(',')})`,
    ownerIds,
  );
  return new Map(rows.map((r) => [r.id, r.name?.trim() || 'A Squircle Labs member']));
};

/* --------------------------------------------------------------------------
   Writing
   -------------------------------------------------------------------------- */

const saveFile = async (id: string, kind: FileKind, name: string, bytes: Buffer) => {
  await run(
    `INSERT INTO template_files (template_id, kind, name, size, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (template_id, kind) DO UPDATE SET name = excluded.name, size = excluded.size,
       sha256 = excluded.sha256, bytes = excluded.bytes, created_at = excluded.created_at`,
    [id, kind, name, bytes.length, createHash('sha256').update(bytes).digest('hex'), bytes, now()],
  );
};

/** "Q3 board-update_FINAL.docx" → "Q3 board update FINAL" */
const titleFromFilename = (filename: string) =>
  filename.replace(/\.[a-z]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.title);

export const createTemplate = async (ownerId: string, filename: string, bytes: Buffer) => {
  const { format, length } = inspect(bytes, filename);
  const id = randomBytes(9).toString('base64url');
  const stamp = now();
  await run(
    `INSERT INTO templates (id, owner_id, title, format, item_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, ownerId, titleFromFilename(filename), format, length, stamp, stamp],
  );
  await saveFile(id, 'original', filename, bytes);
  return getTemplate(id);
};

/** Only drafts change. Anything a reviewer has seen, or is about to, is withdrawn first. */
const assertEditable = (template: Template) => {
  if (template.status === 'in_review' || template.status === 'published') {
    throw new HttpError(409, 'Withdraw this template to make changes.');
  }
};

export interface TemplateInput {
  title?: string;
  description?: string;
  category?: Category;
  tags?: string[];
  usePlaceholder?: boolean;
}

export const updateTemplate = async (template: Template, input: TemplateInput) => {
  assertEditable(template);
  const next = { ...template, ...input };

  // Placeholder text is made once, the first time it's asked for, and kept.
  if (input.usePlaceholder && !(await filesFor(template.id)).placeholder) {
    const original = await getFile(template.id, 'original');
    if (!original) throw new HttpError(409, 'The original file is missing. Upload it again.');
    const name = original.name.replace(/(\.[a-z]+)$/i, ' (placeholder)$1');
    await saveFile(template.id, 'placeholder', name, placeholder(original.bytes, template.format));
  }

  await run(
    `UPDATE templates SET title = ?, description = ?, category = ?, tags = ?, use_placeholder = ?,
       status = 'draft', updated_at = ? WHERE id = ?`,
    [next.title, next.description, next.category, JSON.stringify(next.tags), next.usePlaceholder ? 1 : 0, now(), template.id],
  );
  return getTemplate(template.id);
};

export const addPreview = async (template: Template, image: { path: string; width: number; height: number }) => {
  assertEditable(template);
  const previews = (await previewsFor([template.id])).get(template.id)!;
  if (previews.length >= LIMITS.previews) throw new HttpError(409, `Add up to ${LIMITS.previews} preview images.`);
  const position = previews.length ? Math.max(...previews.map((p) => p.position)) + 1 : 0;
  await run('INSERT INTO template_previews (template_id, position, media, width, height) VALUES (?, ?, ?, ?, ?)', [
    template.id,
    position,
    image.path.split('/').pop()!,
    image.width,
    image.height,
  ]);
  await run('UPDATE templates SET updated_at = ? WHERE id = ?', [now(), template.id]);
};

export const removePreview = async (template: Template, position: number) => {
  assertEditable(template);
  await run('DELETE FROM template_previews WHERE template_id = ? AND position = ?', [template.id, position]);
};

/** Moves an image to the front, where it becomes the cover. */
export const makeCover = async (template: Template, position: number) => {
  assertEditable(template);
  const previews = (await previewsFor([template.id])).get(template.id)!;
  if (!previews.some((p) => p.position === position)) throw new HttpError(404, 'That image is no longer there.');
  const first = Math.min(...previews.map((p) => p.position));
  await run('UPDATE template_previews SET position = ? WHERE template_id = ? AND position = ?', [first - 1, template.id, position]);
};

/** Everything a reviewer needs, checked before it reaches them. */
export const submitTemplate = async (template: Template) => {
  assertEditable(template);
  const missing =
    (!template.title.trim() && ['title', 'Give your template a title.']) ||
    (!template.description.trim() && ['description', 'Describe what your template is for.']) ||
    (!(await previewsFor([template.id])).get(template.id)!.length && ['previews', 'Add at least one preview image.']) ||
    null;
  if (missing) throw new HttpError(422, missing[1]!, missing[0]);

  const source = await getFile(template.id, template.usePlaceholder ? 'placeholder' : 'original');
  if (!source) throw new HttpError(409, 'The file is missing. Upload it again.');
  const name = `${template.title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Template'}.${template.format}`;
  await saveFile(template.id, 'published', name, clean(source.bytes));

  const stamp = now();
  await run(`UPDATE templates SET status = 'in_review', review_note = '', submitted_at = ?, updated_at = ? WHERE id = ?`, [
    stamp,
    stamp,
    template.id,
  ]);
  return getTemplate(template.id);
};

/** Back to a draft: out of the review queue, or off the gallery. */
export const withdrawTemplate = async (template: Template) => {
  if (template.status !== 'in_review' && template.status !== 'published') return template;
  await run(`UPDATE templates SET status = 'draft', updated_at = ? WHERE id = ?`, [now(), template.id]);
  return getTemplate(template.id);
};

export const deleteTemplate = async (id: string) => {
  await run('DELETE FROM template_previews WHERE template_id = ?', [id]);
  await run('DELETE FROM template_files WHERE template_id = ?', [id]);
  await run('DELETE FROM templates WHERE id = ?', [id]);
};

export const deleteTemplatesOf = async (ownerId: string) => {
  for (const { id } of await all<{ id: string }>('SELECT id FROM templates WHERE owner_id = ?', [ownerId])) {
    await deleteTemplate(id);
  }
};

/* --------------------------------------------------------------------------
   Review
   -------------------------------------------------------------------------- */

export const approveTemplate = async (template: Template, adminId: string) => {
  if (template.status !== 'in_review') throw new HttpError(409, 'Only templates waiting for review can be approved.');
  const stamp = now();
  await run(
    `UPDATE templates SET status = 'published', published_at = ?, reviewed_by = ?, reviewed_at = ?, review_note = '', updated_at = ? WHERE id = ?`,
    [stamp, adminId, stamp, stamp, template.id],
  );
  return getTemplate(template.id);
};

/** Declining a submission, or taking down a published template. The creator sees the note. */
export const declineTemplate = async (template: Template, adminId: string, note: string) => {
  if (template.status !== 'in_review' && template.status !== 'published') {
    throw new HttpError(409, 'Only templates in review or on the gallery can be declined.');
  }
  if (!note.trim()) throw new HttpError(422, 'Tell the creator what to change.', 'note');
  const stamp = now();
  await run(
    `UPDATE templates SET status = 'declined', review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
    [note.trim().slice(0, 1000), adminId, stamp, stamp, template.id],
  );
  return getTemplate(template.id);
};

export const countDownload = (id: string) => run('UPDATE templates SET downloads = downloads + 1 WHERE id = ?', [id]);
