import { all, one, run } from '../db/client.js';
import { HttpError, type Article, type ArticleInput, type PublishedArticle } from './types.js';
import { slugify } from './validate.js';

interface Row {
  id: number;
  slug: string;
  slug_custom: number;
  title: string;
  summary: string;
  category: Article['category'];
  body: string;
  hero_image: string | null;
  hero_alt: string;
  hero_width: number | null;
  hero_height: number | null;
  featured: number;
  status: Article['status'];
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

const toArticle = (row: Row): Article => ({
  id: Number(row.id),
  slug: row.slug,
  slugCustom: Number(row.slug_custom) === 1,
  title: row.title,
  summary: row.summary,
  category: row.category,
  body: row.body,
  heroImage: row.hero_image,
  heroAlt: row.hero_alt,
  heroWidth: row.hero_width === null ? null : Number(row.hero_width),
  heroHeight: row.hero_height === null ? null : Number(row.hero_height),
  featured: Number(row.featured) === 1,
  status: row.status,
  publishedAt: row.published_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const now = () => new Date().toISOString();

const slugTaken = async (slug: string, id: number) =>
  Boolean(await one('SELECT 1 FROM articles WHERE slug = ? AND id != ?', [slug, id]));

const uniqueSlug = async (base: string, id: number) => {
  const root = base || 'untitled';
  let candidate = root;
  for (let n = 2; await slugTaken(candidate, id); n += 1) candidate = `${root}-${n}`;
  return candidate;
};

export const listArticles = async () =>
  (await all<Row>(`SELECT * FROM articles ORDER BY (status = 'draft') DESC, COALESCE(published_at, updated_at) DESC, id DESC`)).map(toArticle);

export const listPublished = async () =>
  (
    await all<Row>(
      `SELECT * FROM articles WHERE status = 'published' AND published_at IS NOT NULL ORDER BY published_at DESC, id DESC`,
    )
  ).map(toArticle) as PublishedArticle[];

export const getArticle = async (id: number): Promise<Article> => {
  const row = await one<Row>('SELECT * FROM articles WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, 'That story no longer exists.');
  return toArticle(row);
};

const save = async (article: Article, editorId: string | null): Promise<Article> => {
  try {
    await run(
      `UPDATE articles SET
         slug = ?, slug_custom = ?, title = ?, summary = ?, category = ?, body = ?,
         hero_image = ?, hero_alt = ?, hero_width = ?, hero_height = ?, featured = ?,
         status = ?, published_at = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`,
      [
        article.slug, article.slugCustom ? 1 : 0, article.title, article.summary, article.category, article.body,
        article.heroImage, article.heroAlt, article.heroWidth, article.heroHeight, article.featured ? 1 : 0,
        article.status, article.publishedAt, now(), editorId, article.id,
      ],
    );
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'Another story already uses that URL.', 'slug');
    throw error;
  }
  return getArticle(article.id);
};

export const createArticle = async (input: ArticleInput, editorId: string | null) => {
  const timestamp = now();
  const placeholder = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const result = await run(
    `INSERT INTO articles (slug, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?)`,
    [placeholder, timestamp, timestamp, editorId],
  );
  return updateArticle(Number(result.lastInsertRowid), { ...input, slug: input.slug ?? '' }, editorId);
};

export const updateArticle = async (id: number, input: ArticleInput, editorId: string | null): Promise<Article> => {
  const current = await getArticle(id);
  const next: Article = { ...current };

  for (const key of ['title', 'summary', 'category', 'body', 'heroAlt', 'featured', 'publishedAt'] as const) {
    if (input[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = input[key];
  }

  if (input.heroImage !== undefined) {
    next.heroImage = input.heroImage;
    next.heroWidth = input.heroImage ? (input.heroWidth ?? null) : null;
    next.heroHeight = input.heroImage ? (input.heroHeight ?? null) : null;
    if (!input.heroImage) next.heroAlt = '';
  }

  // URLs are permanent once a story is public: links to it are already out in the world.
  if (current.status === 'published') {
    if (input.slug !== undefined && input.slug !== '' && input.slug !== current.slug) {
      throw new HttpError(409, 'A published story’s URL can’t change. Unpublish it first.', 'slug');
    }
  } else if (input.slug !== undefined && input.slug !== '' && input.slug !== current.slug) {
    if (await slugTaken(input.slug, id)) throw new HttpError(409, 'Another story already uses that URL.', 'slug');
    next.slug = input.slug;
    next.slugCustom = true;
  } else if (input.slug === '' || (!current.slugCustom && input.title !== undefined)) {
    next.slugCustom = false;
    next.slug = await uniqueSlug(slugify(next.title), id);
  }

  if (current.status === 'published') assertPublishable(next);
  return save(next, editorId);
};

/** Everything a reader will see has to be there before a story goes out. */
const assertPublishable = (article: Article) => {
  if (!article.title) throw new HttpError(422, 'Add a headline before publishing.', 'title');
  if (!article.summary) throw new HttpError(422, 'Add a summary before publishing.', 'summary');
  if (!article.body.trim()) throw new HttpError(422, 'Write the story before publishing.', 'body');
  if (article.heroImage && !article.heroAlt) {
    throw new HttpError(422, 'Describe the image for people who use VoiceOver.', 'heroAlt');
  }
};

export const publishArticle = async (id: number, editorId: string | null) => {
  const article = await getArticle(id);
  assertPublishable(article);
  return save({ ...article, status: 'published', publishedAt: article.publishedAt ?? now() }, editorId);
};

export const unpublishArticle = async (id: number, editorId: string | null) =>
  save({ ...(await getArticle(id)), status: 'draft' }, editorId);

export const deleteArticle = async (id: number) => {
  const article = await getArticle(id);
  await run('DELETE FROM articles WHERE id = ?', [id]);
  return article;
};
