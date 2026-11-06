import { CATEGORIES, HttpError, MEDIA_DIR, type ArticleInput, type Category } from './types.js';

export const LIMITS = {
  title: 140,
  summary: 300,
  body: 100_000,
  slug: 80,
  heroAlt: 200,
} as const;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE_PATH = new RegExp(`^${MEDIA_DIR}/[a-f0-9]{16}\\.(?:jpg|png|webp|gif)$`);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.slug)
    .replace(/-+$/, '');

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`, field);
  // Normalise line endings and strip control characters other than newlines and tabs.
  const clean = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (clean.length > max) throw new HttpError(400, `${field} can be at most ${max} characters.`, field);
  return clean;
};

const dimension = (value: unknown, field: string): number | null => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 20_000) {
    throw new HttpError(400, `${field} must be a whole number of pixels.`, field);
  }
  return value;
};

/** Accepts a date (YYYY-MM-DD, stored at midday UTC so it reads the same in London) or a full ISO timestamp. */
const publishDate = (value: unknown): string | null => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Date must be text.', 'publishedAt');
  const iso = DATE_ONLY.test(value) ? `${value}T12:00:00.000Z` : value;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'That date isn’t valid.', 'publishedAt');
  return date.toISOString();
};

export const parseArticleInput = (raw: unknown): ArticleInput => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'Expected a JSON object.');
  }

  const body = raw as Record<string, unknown>;
  const input: ArticleInput = {};

  if ('title' in body) input.title = text(body.title, 'Headline', LIMITS.title).replace(/\s+/g, ' ').trim();
  if ('summary' in body) input.summary = text(body.summary, 'Summary', LIMITS.summary).replace(/\s+/g, ' ').trim();
  if ('body' in body) input.body = text(body.body, 'Story', LIMITS.body);
  if ('heroAlt' in body) input.heroAlt = text(body.heroAlt, 'Image description', LIMITS.heroAlt).trim();

  if ('category' in body) {
    if (typeof body.category !== 'string' || !(body.category in CATEGORIES)) {
      throw new HttpError(400, 'Choose a category.', 'category');
    }
    input.category = body.category as Category;
  }

  if ('slug' in body) {
    const slug = text(body.slug, 'URL', LIMITS.slug).trim();
    if (slug && !SLUG_PATTERN.test(slug)) {
      throw new HttpError(400, 'Use lowercase letters, numbers and single hyphens in the URL.', 'slug');
    }
    input.slug = slug;
  }

  if ('heroImage' in body) {
    if (body.heroImage === null || body.heroImage === '') {
      input.heroImage = null;
    } else if (typeof body.heroImage === 'string' && IMAGE_PATH.test(body.heroImage)) {
      input.heroImage = body.heroImage;
    } else {
      throw new HttpError(400, 'Upload the image through the Newsroom.', 'heroImage');
    }
  }

  if ('heroWidth' in body) input.heroWidth = dimension(body.heroWidth, 'heroWidth');
  if ('heroHeight' in body) input.heroHeight = dimension(body.heroHeight, 'heroHeight');

  if ('featured' in body) {
    if (typeof body.featured !== 'boolean') throw new HttpError(400, 'Featured must be on or off.', 'featured');
    input.featured = body.featured;
  }

  if ('publishedAt' in body) input.publishedAt = publishDate(body.publishedAt);

  return input;
};
