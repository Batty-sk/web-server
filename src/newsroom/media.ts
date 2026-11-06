import { createHash } from 'node:crypto';

import { one, run } from '../db/client.js';
import { HttpError, MEDIA_DIR } from './types.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' } as const;
type Format = keyof typeof MIME;

/** Reads format and pixel size from the file itself rather than trusting the browser. */
export const inspectImage = (buf: Buffer): { format: Format; width: number; height: number } | null => {
  if (buf.length < 30) return null;

  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  if (buf.toString('ascii', 0, 4) === 'GIF8') {
    return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
      return {
        format: 'webp',
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (chunk === 'VP8X') return { format: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return null;
  }

  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) return null;
      const marker = buf[offset + 1]!;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { format: 'jpg', height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + buf.readUInt16BE(offset + 2);
    }
  }

  return null;
};

/** Content-addressed: the same image uploaded twice is stored once, and names never collide. */
export const saveMedia = async (buf: Buffer) => {
  const info = inspectImage(buf);
  if (!info || !info.width || !info.height) throw new HttpError(415, 'Use a JPEG, PNG, WebP or GIF image.');

  const name = `${createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${info.format}`;
  await run(
    'INSERT INTO media (name, mime, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING',
    [name, MIME[info.format], info.width, info.height, buf, new Date().toISOString()],
  );
  return { path: `${MEDIA_DIR}/${name}`, width: info.width, height: info.height };
};

export const getMedia = async (name: string) => {
  const row = await one<{ mime: string; bytes: ArrayBuffer | Uint8Array }>('SELECT mime, bytes FROM media WHERE name = ?', [name]);
  return row ? { mime: row.mime, bytes: Buffer.from(row.bytes as ArrayBuffer) } : null;
};

const MEDIA_REFERENCE = /assets\/newsroom\/([a-f0-9]{16}\.(?:jpg|png|webp|gif))/g;

/** Every image a set of stories uses, so publishing ships exactly those. */
export const referencedMedia = (articles: { heroImage: string | null; body: string }[]) => {
  const names = new Set<string>();
  for (const article of articles) {
    for (const text of [article.heroImage ?? '', article.body]) {
      for (const match of text.matchAll(MEDIA_REFERENCE)) names.add(match[1]!);
    }
  }
  return [...names];
};
