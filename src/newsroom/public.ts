/**
 * The public Newsroom: published stories as JSON, read by the website's static
 * Newsroom pages, plus the RSS feed. Nothing here needs a session.
 */
import { Router, type Response } from 'express';

import { API_URL, SITE_URL } from '../config.js';
import { listPublished, getPublishedBySlug } from './articles.js';
import { mediaUrl, plainText, renderMarkdown, type RenderOptions } from './markdown.js';
import { CATEGORIES, HttpError, type Article } from './types.js';

/** Relative links in a story resolve against the website; images come from this API. */
export const MEDIA: RenderOptions = { base: `${SITE_URL}/`, mediaBase: `${API_URL}/media/` };

export const storyUrl = (slug: string) => `${SITE_URL}/newsroom/story/?slug=${encodeURIComponent(slug)}`;

/** Drafts in preview have no date yet; they show today's. */
const storyDate = (article: Article) => article.publishedAt ?? new Date().toISOString();

/** What a card needs: the Newsroom grid, "Latest News" under a story and the home page tile. */
export const presentCard = (article: Article) => ({
  slug: article.slug,
  url: storyUrl(article.slug),
  title: article.title,
  summary: article.summary,
  category: article.category,
  categoryLabel: CATEGORIES[article.category],
  publishedAt: storyDate(article),
  featured: article.featured,
  image: article.heroImage
    ? {
        url: mediaUrl(article.heroImage, MEDIA),
        alt: article.heroAlt,
        width: article.heroWidth,
        height: article.heroHeight,
      }
    : null,
});

/** A whole story. The body is rendered here, escaped, by the same Markdown renderer the editor previews with. */
export const presentStory = (article: Article) => ({
  ...presentCard(article),
  description: article.summary || plainText(article.body).slice(0, 200),
  updatedAt: article.updatedAt,
  bodyHtml: renderMarkdown(article.body, MEDIA),
});

/** A story page's payload: the story and up to three others to read next. */
export const storyPage = (article: Article, published: Article[]) => ({
  story: presentStory(article),
  more: published.filter((s) => s.id !== article.id).slice(0, 3).map(presentCard),
});

/**
 * Always revalidate, so a story is live the moment it's published. The ETag
 * Express adds makes an unchanged answer a tiny 304.
 */
const fresh = (res: Response) => res.setHeader('Cache-Control', 'public, no-cache');

const xml = (value: string) =>
  value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c);

const renderRss = (stories: Article[]) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Squircle Labs Newsroom</title>
    <link>${SITE_URL}/newsroom/</link>
    <atom:link href="${API_URL}/newsroom/rss.xml" rel="self" type="application/rss+xml"/>
    <description>The latest news and updates from Squircle Labs.</description>
    <language>en-gb</language>
${stories
  .slice(0, 30)
  .map(
    (s) => `    <item>
      <title>${xml(s.title)}</title>
      <link>${xml(storyUrl(s.slug))}</link>
      <guid isPermaLink="true">${xml(storyUrl(s.slug))}</guid>
      <pubDate>${new Date(storyDate(s)).toUTCString()}</pubDate>
      <category>${CATEGORIES[s.category]}</category>
      <description>${xml(s.summary)}</description>
    </item>`,
  )
  .join('\n')}
  </channel>
</rss>
`;

export const newsroomPublic = Router();

/** Every published story, newest first. `?limit=3` for the home page. */
newsroomPublic.get('/stories', async (req, res) => {
  const limit = Number(req.query.limit);
  const stories = await listPublished();
  fresh(res);
  res.json({ stories: (Number.isInteger(limit) && limit > 0 ? stories.slice(0, limit) : stories).map(presentCard) });
});

newsroomPublic.get('/stories/:slug', async (req, res) => {
  const article = await getPublishedBySlug(req.params.slug);
  if (!article) throw new HttpError(404, 'That story isn’t on the Newsroom.');
  fresh(res);
  res.json(storyPage(article, await listPublished()));
});

newsroomPublic.get('/rss.xml', async (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/rss+xml').send(renderRss(await listPublished()));
});
