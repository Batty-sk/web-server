import { listPublished } from '../newsroom/articles.js';
import { getMedia, referencedMedia } from '../newsroom/media.js';
import { renderArticle, renderFeedJson, renderIndex, renderLandingSection, renderRss } from '../newsroom/templates.js';

export interface SiteBuild {
  /** Every file under newsroom/. The generator owns that folder outright. */
  newsroom: Map<string, string>;
  /** Images under assets/newsroom/ that published stories use, by file name. */
  media: Map<string, Buffer>;
  /** Rewrites the company page's newsroom tile between its markers. */
  landing: (indexHtml: string) => { html: string; found: boolean };
  stories: number;
}

const MARKERS = /(<!-- newsroom:start[^>]*-->)[\s\S]*?(\n\s*<!-- newsroom:end -->)/;

export const buildSite = async (): Promise<SiteBuild> => {
  const stories = await listPublished();

  const newsroom = new Map<string, string>([
    ['index.html', renderIndex(stories)],
    ['rss.xml', renderRss(stories)],
    ['feed.json', renderFeedJson(stories)],
  ]);
  for (const story of stories) newsroom.set(`${story.slug}/index.html`, renderArticle(story, stories));

  const media = new Map<string, Buffer>();
  for (const name of referencedMedia(stories)) {
    const file = await getMedia(name);
    if (file) media.set(name, file.bytes);
    else console.warn(`newsroom: image ${name} is referenced but was never uploaded.`);
  }

  const section = renderLandingSection(stories);
  const landing = (indexHtml: string) => ({
    found: MARKERS.test(indexHtml),
    html: indexHtml.replace(MARKERS, (_, start: string, end: string) => (section ? `${start}\n      ${section}${end}` : `${start}${end}`)),
  });

  return { newsroom, media, landing, stories: stories.length };
};
