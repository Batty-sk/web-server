import { CANONICAL_URL as SITE_URL } from '../config.js';
import { html, raw, type SafeHtml } from './html.js';
import { mediaUrl, plainText, renderMarkdown, type RenderOptions } from './markdown.js';
import { SQUIRCLE_PATH } from './squircle.js';
import { CATEGORIES, type Article } from './types.js';

/* --------------------------------------------------------------------------
   Formatting
   -------------------------------------------------------------------------- */

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/London',
});

export const formatDate = (iso: string) => dateFormat.format(new Date(iso));

export const storyPath = (article: Pick<Article, 'slug'>) => `newsroom/${article.slug}/`;
export const storyUrl = (article: Pick<Article, 'slug'>) => `${SITE_URL}/${storyPath(article)}`;

const absolute = (sitePath: string) => `${SITE_URL}/${sitePath}`;

/** JSON inside <script> must not be able to close the element. */
const jsonLd = (data: unknown) => raw(JSON.stringify(data, null, 2).replace(/</g, '\\u003c'));

/** Anything with a date the reader can see. Drafts in preview fall back to "today". */
type Story = Article & { publishedAt: string | null };
const storyDate = (article: Story) => article.publishedAt ?? new Date().toISOString();

/* --------------------------------------------------------------------------
   Shared chrome — mirrors index.html so the newsroom reads as the same site
   -------------------------------------------------------------------------- */

const sprite = html`<svg width="0" height="0" class="sprite" aria-hidden="true" focusable="false">
      <symbol id="squircle" viewBox="0 0 100 100"><path d="${SQUIRCLE_PATH}"/></symbol>
    </svg>`;

const globalNav = (base: string) => html`<header class="globalnav">
      <nav class="globalnav__inner" aria-label="Squircle Labs">
        <a class="globalnav__brand" href="${base}index.html" aria-label="Squircle Labs, home">
          <svg class="globalnav__mark" aria-hidden="true" focusable="false"><use href="#squircle"></use></svg>
        </a>

        <ul class="globalnav__links" id="globalnav-links">
          <li><a href="${base}manuscript.html">Manuscript</a></li>
          <li><a href="${base}index.html#philosophy">Philosophy</a></li>
          <li><a href="${base}index.html#letter">Founder’s Letter</a></li>
          <li><a href="${base}newsroom/" aria-current="page">Newsroom</a></li>
          <li><a href="${base}contact.html">Support</a></li>
          <li><a href="${base}account/" data-account-link>Sign In</a></li>
        </ul>

        <button
          class="globalnav__toggle"
          type="button"
          aria-controls="globalnav-links"
          aria-expanded="false"
          aria-label="Open menu"
          data-menu-toggle
        >
          <span aria-hidden="true"></span>
        </button>
      </nav>
    </header>`;

const localNav = (base: string, isIndex: boolean) => html`<nav class="localnav" aria-label="Newsroom">
      <div class="localnav__inner">
        ${
          isIndex
            ? html`<span class="localnav__title">Newsroom</span>`
            : html`<a class="localnav__title" href="${base}newsroom/">Newsroom</a>`
        }
        <a class="localnav__link" href="${base}newsroom/rss.xml">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>
          RSS
        </a>
      </div>
    </nav>`;

const globalFooter = (base: string) => html`<footer class="globalfooter">
      <div class="globalfooter__inner">
        <nav class="globalfooter__directory" aria-label="Site directory">
          <div class="globalfooter__col">
            <h2>Manuscript</h2>
            <ul>
              <li><a href="${base}manuscript.html">Overview</a></li>
              <li><a href="${base}templates/">Templates</a></li>
              <li><a href="${base}requirements.html">System Requirements</a></li>
            </ul>
          </div>
          <div class="globalfooter__col">
            <h2>Support</h2>
            <ul>
              <li><a href="${base}help.html">Help Center</a></li>
              <li><a href="${base}contact.html">Contact Support</a></li>
            </ul>
          </div>
          <div class="globalfooter__col">
            <h2>Squircle Labs</h2>
            <ul>
              <li><a href="${base}newsroom/">Newsroom</a></li>
              <li><a href="${base}index.html#philosophy">Product Philosophy</a></li>
              <li><a href="${base}index.html#letter">Founder’s Letter</a></li>
              <li>
                <a href="https://www.linkedin.com/company/squirclelondon/" target="_blank" rel="noopener noreferrer">LinkedIn</a>
              </li>
            </ul>
          </div>
        </nav>

        <div class="globalfooter__legal">
          <p>© <span data-current-year>${new Date().getFullYear()}</span> Squircle Labs. Emotion in Motion.</p>
          <ul>
            <li><a href="${base}privacy.html">Privacy Policy</a></li>
            <li><a href="${base}terms.html">Terms of Use</a></li>
          </ul>
          <p class="globalfooter__locale">United Kingdom</p>
        </div>
      </div>
    </footer>`;

interface PageOptions {
  base: string;
  title: string;
  description: string;
  canonical: string;
  bodyClass: string;
  themeColor: string;
  og: { type: 'website' | 'article'; image?: string | null };
  head?: SafeHtml;
  content: SafeHtml;
  isIndex: boolean;
  preview?: boolean;
}

const page = (o: PageOptions) => html`<!doctype html>
<html lang="en-GB" class="no-js">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">

    <title>${o.title}</title>
    <meta name="description" content="${o.description}">
    <meta name="robots" content="${o.preview ? 'noindex, nofollow' : 'index, follow, max-image-preview:large'}">
    <meta name="theme-color" content="${o.themeColor}">
    <meta name="color-scheme" content="light">
    <link rel="canonical" href="${o.canonical}">
    <link rel="alternate" type="application/rss+xml" title="Squircle Labs Newsroom" href="${absolute('newsroom/rss.xml')}">

    <meta property="og:type" content="${o.og.type}">
    <meta property="og:locale" content="en_GB">
    <meta property="og:site_name" content="Squircle Labs Newsroom">
    <meta property="og:title" content="${o.title}">
    <meta property="og:description" content="${o.description}">
    <meta property="og:url" content="${o.canonical}">
    ${o.og.image ? html`<meta property="og:image" content="${o.og.image}">` : ''}
    <meta name="twitter:card" content="${o.og.image ? 'summary_large_image' : 'summary'}">

    <link rel="icon" href="${o.base}assets/icons/squircle.svg" type="image/svg+xml">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Geist:wght@300..900&amp;display=swap"
    >
    <link rel="stylesheet" href="${o.base}assets/styles/company.css">
    ${o.head ?? ''}
    <script>
      document.documentElement.classList.replace('no-js', 'js');
    </script>
    <script defer src="${o.base}assets/scripts/company.js"></script>
  </head>
  <body class="${o.bodyClass}">
    <!-- Generated by newsroom-cms. Edits made here are replaced on the next publish. -->
    ${sprite}

    <a class="skip-link" href="#main-content">Skip to main content</a>
    ${o.preview ? html`<p class="nr-preview-banner" role="status">Preview — only you can see this.</p>` : ''}

    ${globalNav(o.base)}
    ${localNav(o.base, o.isIndex)}

    ${o.content}

    ${globalFooter(o.base)}
  </body>
</html>
`;

/* --------------------------------------------------------------------------
   Story cards
   -------------------------------------------------------------------------- */

const cover = (article: Story, media: RenderOptions, sizes: string, eager = false) => {
  if (article.heroImage) {
    return html`<img
              src="${mediaUrl(article.heroImage, media)}"
              alt=""
              ${article.heroWidth ? html`width="${article.heroWidth}" height="${article.heroHeight}"` : ''}
              sizes="${sizes}"
              loading="${eager ? 'eager' : 'lazy'}"
              decoding="async"
            >`;
  }

  // No photograph: the squircle on the category's tone, so every story still has a face.
  return html`<span class="news-cover news-cover--${article.category}" aria-hidden="true">
              <svg focusable="false"><use href="#squircle"></use></svg>
            </span>`;
};

type CardOptions = { base: string; mediaBase?: string; heading: 'h2' | 'h3'; featured?: boolean };

export const card = (article: Story, { base, mediaBase, heading, featured = false }: CardOptions) => {
  const title =
    featured || heading === 'h2'
      ? html`<h2 class="news-card__title">${article.title}</h2>`
      : html`<h3 class="news-card__title">${article.title}</h3>`;

  return html`<li class="news-card${featured ? ' news-card--featured' : ''}">
        <a class="news-card__link" href="${base}${storyPath(article)}">
          <div class="news-card__media">
            ${cover(article, { base, mediaBase }, featured ? '(max-width: 734px) 100vw, 66vw' : '(max-width: 734px) 100vw, 33vw', featured)}
          </div>
          <div class="news-card__copy">
            <p class="news-card__category">${CATEGORIES[article.category]}</p>
            ${title}
            ${featured && article.summary ? html`<p class="news-card__summary">${article.summary}</p>` : ''}
            <p class="news-card__date"><time datetime="${storyDate(article).slice(0, 10)}">${formatDate(storyDate(article))}</time></p>
          </div>
        </a>
      </li>`;
};

/* --------------------------------------------------------------------------
   Newsroom index
   -------------------------------------------------------------------------- */

/** The newest story marked Featured leads; otherwise the newest story does. */
export const pickFeatured = <T extends Article>(stories: T[]): T | undefined =>
  stories.find((s) => s.featured) ?? stories[0];

export const renderIndex = (stories: Story[]) => {
  const base = '../';
  const featured = pickFeatured(stories);
  const rest = stories.filter((s) => s !== featured);

  const content = featured
    ? html`<main id="main-content" class="newsroom">
      <h1 class="visually-hidden">Squircle Labs Newsroom</h1>

      <section class="nr-section nr-section--featured" aria-label="Featured story">
        <ul class="news-grid news-grid--featured">
          ${card(featured, { base, heading: 'h2', featured: true })}
        </ul>
      </section>

      ${
        rest.length
          ? html`<section class="nr-section" aria-labelledby="latest-title">
        <h2 class="nr-section__title" id="latest-title">Latest News</h2>
        <ul class="news-grid">
          ${rest.map((s) => card(s, { base, heading: 'h3' }))}
        </ul>
      </section>`
          : ''
      }
    </main>`
    : html`<main id="main-content" class="newsroom">
      <section class="nr-empty" aria-labelledby="empty-title">
        <svg class="nr-empty__mark" aria-hidden="true" focusable="false"><use href="#squircle"></use></svg>
        <h1 id="empty-title">Newsroom</h1>
        <p>News from Squircle Labs will appear here. Check back&nbsp;soon.</p>
      </section>
    </main>`;

  return page({
    base,
    title: 'Newsroom — Squircle Labs',
    description: 'The latest news, press releases and updates from Squircle Labs, makers of Manuscript for Mac.',
    canonical: absolute('newsroom/'),
    bodyClass: 'page-newsroom page-newsroom--index',
    themeColor: '#f5f5f7',
    og: { type: 'website', image: featured?.heroImage ? absolute(featured.heroImage) : null },
    content,
    isIndex: true,
  }).value;
};

/* --------------------------------------------------------------------------
   Story page
   -------------------------------------------------------------------------- */

const ICONS = {
  link: raw('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  check: raw('<path d="M20 6 9 17l-5-5"/>'),
  mail: raw('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
  linkedin: raw('<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/><rect width="4" height="12" x="2" y="9"/><circle cx="4" cy="4" r="2"/>'),
};

const shareRow = (article: Story) => {
  const url = storyUrl(article);
  const linkedin = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
  const mail = `mailto:?subject=${encodeURIComponent(article.title)}&body=${encodeURIComponent(`${article.summary}\n\n${url}`)}`;

  return html`<ul class="nr-share" aria-label="Share this story">
            <li>
              <a class="nr-share__button" href="${linkedin}" target="_blank" rel="noopener noreferrer" aria-label="Share on LinkedIn">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS.linkedin}</svg>
              </a>
            </li>
            <li>
              <a class="nr-share__button" href="${mail}" aria-label="Share by email">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS.mail}</svg>
              </a>
            </li>
            <li class="nr-share__copy">
              <button class="nr-share__button" type="button" data-copy-link="${url}" aria-label="Copy link">
                <svg class="nr-share__icon-link" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS.link}</svg>
                <svg class="nr-share__icon-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS.check}</svg>
              </button>
              <span class="nr-share__status" role="status" aria-live="polite"></span>
            </li>
          </ul>`;
};

export const renderArticle = (
  article: Story,
  all: Story[],
  options: { base?: string; mediaBase?: string; preview?: boolean } = {},
) => {
  const base = options.base ?? '../../';
  const media = { base, mediaBase: options.mediaBase };
  const date = storyDate(article);
  const more = all.filter((s) => s.id !== article.id).slice(0, 3);
  const image = article.heroImage ? absolute(article.heroImage) : null;
  const description = article.summary || plainText(article.body).slice(0, 200);

  const structured = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: article.title,
    description,
    datePublished: date,
    dateModified: article.updatedAt,
    mainEntityOfPage: storyUrl(article),
    ...(image ? { image: [image] } : {}),
    author: { '@type': 'Organization', name: 'Squircle Labs', url: `${SITE_URL}/` },
    publisher: {
      '@type': 'Organization',
      name: 'Squircle Labs',
      logo: { '@type': 'ImageObject', url: absolute('assets/icons/favicon.png') },
    },
  };

  const content = html`<main id="main-content" class="newsroom newsroom--story">
      <article class="nr-story" aria-labelledby="story-title">
        <header class="nr-story__header">
          <p class="nr-story__meta">
            <span class="nr-story__category">${CATEGORIES[article.category]}</span>
            <time datetime="${date.slice(0, 10)}">${formatDate(date)}</time>
          </p>
          <h1 id="story-title">${article.title}</h1>
          ${article.summary ? html`<p class="nr-story__summary">${article.summary}</p>` : ''}
          ${shareRow(article)}
        </header>

        ${
          article.heroImage
            ? html`<figure class="nr-story__hero">
          <img
            src="${mediaUrl(article.heroImage, media)}"
            alt="${article.heroAlt}"
            ${article.heroWidth ? html`width="${article.heroWidth}" height="${article.heroHeight}"` : ''}
            fetchpriority="high"
            decoding="async"
          >
        </figure>`
            : ''
        }

        <div class="nr-story__body">
          ${raw(renderMarkdown(article.body, media))}
        </div>
      </article>

      ${
        more.length
          ? html`<section class="nr-more" aria-labelledby="more-title">
        <div class="nr-more__inner">
          <h2 class="nr-section__title" id="more-title">Latest News</h2>
          <ul class="news-grid">
            ${more.map((s) => card(s, { ...media, heading: 'h3' }))}
          </ul>
          <p class="nr-more__all"><a class="chevron-link" href="${base}newsroom/">View all news</a></p>
        </div>
      </section>`
          : ''
      }
    </main>`;

  return page({
    base,
    title: `${article.title || 'Untitled story'} — Squircle Labs Newsroom`,
    description,
    canonical: storyUrl(article),
    bodyClass: 'page-newsroom page-newsroom--story',
    themeColor: '#ffffff',
    og: { type: 'article', image },
    head: html`<meta property="article:published_time" content="${date}">
    <script type="application/ld+json">
${jsonLd(structured)}
    </script>`,
    content,
    isIndex: false,
    preview: options.preview,
  }).value;
};

/* --------------------------------------------------------------------------
   Company landing page section (injected into index.html between markers)
   -------------------------------------------------------------------------- */

export const renderLandingSection = (stories: Story[]) => {
  if (!stories.length) return '';

  return html`<section class="tile tile--newsroom" id="newsroom" aria-labelledby="newsroom-title">
        <header class="newsroom-tile__header" data-reveal>
          <p class="eyebrow">Newsroom</p>
          <h2 id="newsroom-title">The latest from Squircle&nbsp;Labs.</h2>
          <p class="tile__links"><a class="chevron-link" href="newsroom/">Visit the Newsroom</a></p>
        </header>
        <ul class="news-grid" data-reveal>
          ${stories.slice(0, 3).map((s) => card(s, { base: '', heading: 'h3' }))}
        </ul>
      </section>`.value;
};

/* --------------------------------------------------------------------------
   Feeds
   -------------------------------------------------------------------------- */

const xml = (value: string) =>
  value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c);

export const renderRss = (stories: Story[]) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Squircle Labs Newsroom</title>
    <link>${absolute('newsroom/')}</link>
    <atom:link href="${absolute('newsroom/rss.xml')}" rel="self" type="application/rss+xml"/>
    <description>The latest news and updates from Squircle Labs.</description>
    <language>en-gb</language>
${stories
  .slice(0, 30)
  .map(
    (s) => `    <item>
      <title>${xml(s.title)}</title>
      <link>${storyUrl(s)}</link>
      <guid isPermaLink="true">${storyUrl(s)}</guid>
      <pubDate>${new Date(storyDate(s)).toUTCString()}</pubDate>
      <category>${CATEGORIES[s.category]}</category>
      <description>${xml(s.summary)}</description>
    </item>`,
  )
  .join('\n')}
  </channel>
</rss>
`;

export const renderFeedJson = (stories: Story[]) =>
  JSON.stringify(
    {
      title: 'Squircle Labs Newsroom',
      home: absolute('newsroom/'),
      stories: stories.map((s) => ({
        slug: s.slug,
        url: storyUrl(s),
        title: s.title,
        summary: s.summary,
        category: s.category,
        categoryLabel: CATEGORIES[s.category],
        publishedAt: storyDate(s),
        image: s.heroImage ? absolute(s.heroImage) : null,
        imageAlt: s.heroAlt || null,
        featured: s.featured,
      })),
    },
    null,
    2,
  );
