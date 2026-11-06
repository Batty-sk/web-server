/**
 * A deliberately small Markdown dialect for newsroom stories:
 *
 *   ## Heading / ### Subheading
 *   Paragraphs separated by blank lines
 *   **bold**, *italic*, [link](url), `code`
 *   - bulleted and 1. numbered lists
 *   > Pull quotes, with an optional final line "— Name, Title"
 *   ![Description](assets/newsroom/image.webp "Optional caption")
 *   ---
 *
 * Text is escaped before any formatting is applied, so editors can't inject HTML.
 */
import { escapeHtml } from './html.js';

export interface RenderOptions {
  /** Prefix that turns site-relative paths into working URLs from the page being rendered. */
  base: string;
  /** Where newsroom images are served from, when that isn't the site (draft previews read them from the API). */
  mediaBase?: string;
}

const MEDIA_PREFIX = 'assets/newsroom/';

/** A newsroom image path as a URL, from the site or, for previews, the API. */
export const mediaUrl = (path: string, { base, mediaBase }: RenderOptions) =>
  mediaBase && path.startsWith(MEDIA_PREFIX) ? mediaBase + path.slice(MEDIA_PREFIX.length) : base + path;

const SAFE_SCHEME = /^(https?:|mailto:)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Returns a usable URL, or null if it could run script or leave the site in an unexpected way. */
const resolveUrl = (url: string, base: string): string | null => {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (SAFE_SCHEME.test(trimmed)) return trimmed;
  if (ANY_SCHEME.test(trimmed) || trimmed.startsWith('//')) return null;
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return trimmed;
  return base + trimmed;
};

const resolveImage = (src: string, options: RenderOptions): string | null => {
  const trimmed = src.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^assets\/[\w./-]+$/.test(trimmed) && !trimmed.includes('..')) return mediaUrl(trimmed, options);
  return null;
};

/** Inline formatting on already-escaped text. */
const inline = (escaped: string, base: string): string => {
  const codes: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // URLs may contain one level of balanced parentheses, e.g. Wikipedia links.
  out = out.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (match, label: string, url: string) => {
    // The URL was escaped with the text; unescape &amp; so the resolver sees the real value.
    const href = resolveUrl(url.replace(/&amp;/g, '&'), base);
    return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
  });

  out = out
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/ -- /g, ' – ');

  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)] ?? '');
};

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)$/;

export const renderMarkdown = (source: string, options: RenderOptions): string => {
  const { base } = options;
  const lines = escapeHtml(source.replace(/\r\n?/g, '\n')).split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${inline(paragraph.join(' '), base)}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    blocks.push(`<${tag}>${list.items.map((item) => `<li>${inline(item, base)}</li>`).join('')}</${tag}>`);
    list = null;
  };

  const flushQuote = () => {
    if (!quote) return;
    const parts = quote.filter(Boolean);
    const last = parts.at(-1) ?? '';
    const cite = parts.length > 1 && /^(—|--|-)\s+/.test(last) ? last.replace(/^(—|--|-)\s+/, '') : null;
    const text = (cite ? parts.slice(0, -1) : parts).join(' ');
    blocks.push(
      `<figure class="nr-quote"><blockquote><p>${inline(text, base)}</p></blockquote>` +
        (cite ? `<figcaption>${inline(cite, base)}</figcaption>` : '') +
        '</figure>',
    );
    quote = null;
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushAll();
      continue;
    }

    // Quotes continue across consecutive "> " lines.
    if (line.startsWith('&gt;')) {
      flushParagraph();
      flushList();
      quote ??= [];
      quote.push(line.replace(/^&gt;\s?/, ''));
      continue;
    }
    flushQuote();

    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${inline(heading[2]!, base)}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line)) {
      flushAll();
      blocks.push('<hr>');
      continue;
    }

    const image = IMAGE_LINE.exec(line);
    if (image) {
      flushAll();
      const src = resolveImage(image[2]!.replace(/&amp;/g, '&'), options);
      if (src) {
        const caption = image[3] ? `<figcaption>${inline(image[3], base)}</figcaption>` : '';
        blocks.push(
          `<figure class="nr-figure"><img src="${escapeHtml(src)}" alt="${image[1]}" loading="lazy" decoding="async">${caption}</figure>`,
        );
      }
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushAll();
  return blocks.join('\n');
};

/** Plain text for descriptions and reading-time estimates. */
export const plainText = (source: string): string =>
  source
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
