export { HttpError } from '../http/errors.js';

export const CATEGORIES = {
  'press-release': 'Press Release',
  update: 'Update',
  feature: 'Feature',
} as const;

export type Category = keyof typeof CATEGORIES;
export type Status = 'draft' | 'published';

/** Images are stored under this site path once published. */
export const MEDIA_DIR = 'assets/newsroom';

export interface Article {
  id: number;
  slug: string;
  slugCustom: boolean;
  title: string;
  summary: string;
  category: Category;
  body: string;
  heroImage: string | null;
  heroAlt: string;
  heroWidth: number | null;
  heroHeight: number | null;
  featured: boolean;
  status: Status;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PublishedArticle = Article & { status: 'published'; publishedAt: string };

export interface ArticleInput {
  title?: string;
  summary?: string;
  category?: Category;
  body?: string;
  slug?: string;
  heroImage?: string | null;
  heroAlt?: string;
  heroWidth?: number | null;
  heroHeight?: number | null;
  featured?: boolean;
  publishedAt?: string | null;
}
