/**
 * Word, Excel and PowerPoint files (Office Open XML) are zip archives of XML
 * parts. This module reads them without any Office software:
 *
 *   inspect()      checks an upload is a real, safe .docx, .xlsx or .pptx
 *   placeholder()  replaces the words with Lorem Ipsum, keeping every run,
 *                  paragraph, style, table and layout exactly as it was
 *   clean()        strips the personal details Office stores in every file
 *   sample()       the first few paragraphs, to compare before and after
 *
 * Everything works on the XML text with narrow, well-known patterns. Text in
 * these formats always sits inside a handful of elements (<w:t>, <a:t>, <t>),
 * so the structure around it is never touched.
 */
import { createHash } from 'node:crypto';

import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate';

import { HttpError } from '../http/errors.js';

export type Format = 'docx' | 'xlsx' | 'pptx';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Office files compress well, but not this well: anything bigger is a zip bomb. */
const MAX_UNPACKED_BYTES = 250 * 1024 * 1024;
const MAX_PARTS = 5000;

const MAIN_PART: Record<Format, string> = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
};

export const MIME: Record<Format, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/* --------------------------------------------------------------------------
   Reading and writing the archive
   -------------------------------------------------------------------------- */

const unpack = (bytes: Uint8Array): Unzipped => {
  let total = 0;
  let count = 0;
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        total += file.originalSize;
        count += 1;
        if (total > MAX_UNPACKED_BYTES || count > MAX_PARTS) throw new Error('too large');
        return true;
      },
    });
  } catch {
    throw new HttpError(415, 'That file can’t be read. Upload a Word document, Excel spreadsheet or PowerPoint presentation, without a password.');
  }
};

const pack = (parts: Unzipped) => Buffer.from(zipSync(parts, { level: 6 }));

const text = (parts: Unzipped, name: string) => (parts[name] ? strFromU8(parts[name]) : null);

/** Applies `edit` to every part whose name matches, writing back only what changed. */
const editParts = (parts: Unzipped, match: RegExp, edit: (xml: string, name: string) => string) => {
  for (const name of Object.keys(parts)) {
    if (!match.test(name)) continue;
    const before = strFromU8(parts[name]!);
    const after = edit(before, name);
    if (after !== before) parts[name] = strToU8(after);
  }
};

/* --------------------------------------------------------------------------
   inspect — is this a template we can accept?
   -------------------------------------------------------------------------- */

/** Executable content: macros, ActiveX controls, embedded OLE objects and programs. */
const UNSAFE_PART = /(?:^|\/)vbaProject\.bin$|(?:^|\/)activeX\/|oleObject\d*\.bin$|\.(?:exe|dll|js|vbs|bat|cmd|ps1|jar|scr|com|msi)$/i;

const lengthOf = (format: Format, parts: Unzipped): number | null => {
  const names = Object.keys(parts);
  if (format === 'pptx') return names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length || null;
  if (format === 'xlsx') return names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length || null;
  const pages = text(parts, 'docProps/app.xml')?.match(/<Pages>(\d+)<\/Pages>/);
  return pages ? Number(pages[1]) || null : null;
};

export const inspect = (bytes: Buffer, filename: string) => {
  if (!bytes.length) throw new HttpError(400, 'Choose a file to upload.');
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'Templates can be up to 25 MB.');

  const parts = unpack(bytes);
  const format = (Object.keys(MAIN_PART) as Format[]).find((f) => parts[MAIN_PART[f]]);
  if (!format || !parts['[Content_Types].xml']) {
    throw new HttpError(415, 'Upload a Word document (.docx), Excel spreadsheet (.xlsx) or PowerPoint presentation (.pptx).');
  }

  // The contents decide the format; the name only has to agree with it.
  const extension = filename.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (extension && extension !== format) {
    throw new HttpError(415, `That file is a .${format} file named .${extension}. Rename it and try again.`);
  }

  const contentTypes = text(parts, '[Content_Types].xml') ?? '';
  if (/macroEnabled/i.test(contentTypes) || Object.keys(parts).some((n) => UNSAFE_PART.test(n))) {
    throw new HttpError(415, 'Templates can’t contain macros, ActiveX controls or embedded programs. Save a copy without them and try again.');
  }

  return { format, length: lengthOf(format, parts) };
};

/* --------------------------------------------------------------------------
   Text elements, per format
   -------------------------------------------------------------------------- */

/** Parts that hold the document's own words, and the element each keeps them in. */
const TEXT_PARTS: Record<Format, { parts: RegExp; elements: string[] }[]> = {
  docx: [
    { parts: /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments\w*)\.xml$/, elements: ['w:t', 'w:delText'] },
    { parts: /^word\/(?:charts|diagrams)\/[^/]+\.xml$/, elements: ['a:t'] },
  ],
  pptx: [
    { parts: /^ppt\/(?:slides\/slide|notesSlides\/notesSlide)\d+\.xml$/, elements: ['a:t'] },
    { parts: /^ppt\/(?:charts|diagrams)\/[^/]+\.xml$/, elements: ['a:t'] },
    { parts: /^ppt\/comments\/[^/]+\.xml$/, elements: ['p:text'] },
  ],
  xlsx: [
    { parts: /^xl\/(?:sharedStrings|comments\d*)\.xml$/, elements: ['t'] },
    // Strings typed straight into a cell, rather than shared.
    { parts: /^xl\/worksheets\/sheet\d+\.xml$/, elements: ['t'] },
    { parts: /^xl\/(?:charts|drawings)\/[^/]+\.xml$/, elements: ['a:t'] },
  ],
};

const elementPattern = (elements: string[]) =>
  new RegExp(`(<(${elements.map((e) => e.replace(':', '\\:')).join('|')})(?:\\s[^>]*)?>)([^<]*)(</\\2>)`, 'g');

const decode = (value: string) =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const encode = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* --------------------------------------------------------------------------
   placeholder — Lorem Ipsum, with every bit of formatting kept
   -------------------------------------------------------------------------- */

const LOREM = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et ' +
  'dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea ' +
  'commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur ' +
  'excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum ' +
  'integer nunc vitae porta massa vivamus sapien mauris lectus fusce turpis tellus nibh praesent maecenas'
).split(' ');

/** Lorem words grouped by length, so a replacement takes up about the same room on the page. */
const BY_LENGTH = new Map<number, string[]>();
for (const word of LOREM) BY_LENGTH.set(word.length, [...(BY_LENGTH.get(word.length) ?? []), word]);
const LONGEST = Math.max(...BY_LENGTH.keys());

/** A small seeded generator, so the same file always gets the same placeholder text. */
const random = (seed: string) => {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const loremWord = (length: number, next: () => number) => {
  for (let delta = 0; delta <= LONGEST; delta += 1) {
    for (const candidate of [length - delta, length + delta]) {
      const words = BY_LENGTH.get(candidate);
      if (words) return words[Math.floor(next() * words.length)]!;
    }
  }
  return 'lorem';
};

/** Keeps the original's shape: ALL CAPS, Capitalised or lower case. */
const matchCase = (original: string, replacement: string) => {
  if (original.length > 1 && original === original.toUpperCase() && original !== original.toLowerCase()) {
    return replacement.toUpperCase();
  }
  if (original[0] !== original[0]!.toLowerCase()) return replacement[0]!.toUpperCase() + replacement.slice(1);
  return replacement;
};

/** Words become Lorem Ipsum and digits become other digits; spacing and punctuation stay. */
const scramble = (value: string, next: () => number) =>
  value.replace(/(\p{L}+)|(\p{Nd})/gu, (_, word: string | undefined) =>
    word ? matchCase(word, loremWord(word.length, next)) : String(Math.floor(next() * 10)),
  );

export const placeholder = (bytes: Buffer, format: Format) => {
  const parts = unpack(bytes);
  const next = random(createHash('sha256').update(bytes).digest('hex'));

  for (const { parts: match, elements } of TEXT_PARTS[format]) {
    const pattern = elementPattern(elements);
    editParts(parts, match, (xml) =>
      xml.replace(pattern, (_, open: string, _tag: string, inner: string, close: string) =>
        open + encode(scramble(decode(inner), next)) + close,
      ),
    );
  }

  // Links out of the document can name the company or the client; point them somewhere neutral.
  editParts(parts, /\.rels$/, (xml) =>
    xml.replace(/<Relationship\b[^>]*\bTargetMode="External"[^>]*\/>/g, (rel) =>
      /\/hyperlink"/.test(rel) ? rel.replace(/\bTarget="[^"]*"/, 'Target="https://example.com/"') : rel,
    ),
  );

  // The file's own title, subject and keywords usually repeat its contents.
  editParts(parts, /^docProps\/core\.xml$/, (xml) =>
    xml.replace(/(<(dc:title|dc:subject|dc:description|cp:keywords|cp:category)(?:\s[^>]*)?>)[^<]*(<\/\2>)/g, '$1$3'),
  );

  return pack(parts);
};

/* --------------------------------------------------------------------------
   clean — what every shared template loses, placeholder or not
   -------------------------------------------------------------------------- */

export const clean = (bytes: Buffer) => {
  const parts = unpack(bytes);

  // Who wrote it, who edited it last, and where they work.
  editParts(parts, /^docProps\/core\.xml$/, (xml) =>
    xml.replace(/(<(dc:creator|cp:lastModifiedBy)(?:\s[^>]*)?>)[^<]*(<\/\2>)/g, '$1$3'),
  );
  editParts(parts, /^docProps\/app\.xml$/, (xml) => xml.replace(/(<(Company|Manager)>)[^<]*(<\/\2>)/g, '$1$3'));
  editParts(parts, /^docProps\/custom\.xml$/, (xml) => xml.replace(/(<vt:lpwstr>)[^<]*(<\/vt:lpwstr>)/g, '$1$2'));

  // Names on comments and tracked changes.
  editParts(parts, /\.xml$/, (xml) =>
    xml
      .replace(/\b(w:author|w15:userId)="[^"]*"/g, '$1="Author"')
      .replace(/\bw:initials="[^"]*"/g, 'w:initials="A"'),
  );
  editParts(parts, /^ppt\/commentAuthors\.xml$/, (xml) =>
    xml.replace(/\bname="[^"]*"/g, 'name="Author"').replace(/\binitials="[^"]*"/g, 'initials="A"'),
  );
  editParts(parts, /^xl\/comments\d*\.xml$/, (xml) => xml.replace(/(<author>)[^<]*(<\/author>)/g, '$1Author$2'));

  return pack(parts);
};

/* --------------------------------------------------------------------------
   sample — the first paragraphs, for a before-and-after look
   -------------------------------------------------------------------------- */

const PARAGRAPHS: Record<Format, { parts: RegExp; paragraph: RegExp; element: string }> = {
  docx: { parts: /^word\/document\.xml$/, paragraph: /<w:p[\s>][\s\S]*?<\/w:p>/g, element: 'w:t' },
  pptx: { parts: /^ppt\/slides\/slide\d+\.xml$/, paragraph: /<a:p>[\s\S]*?<\/a:p>/g, element: 'a:t' },
  xlsx: { parts: /^xl\/sharedStrings\.xml$/, paragraph: /<si>[\s\S]*?<\/si>/g, element: 't' },
};

const slideNumber = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

export const sample = (bytes: Buffer, format: Format, count = 6): string[] => {
  const parts = unpack(bytes);
  const { parts: match, paragraph, element } = PARAGRAPHS[format];
  const names = Object.keys(parts).filter((n) => match.test(n)).sort((a, b) => slideNumber(a) - slideNumber(b));
  const words = elementPattern([element]);
  const out: string[] = [];

  for (const name of names) {
    for (const p of strFromU8(parts[name]!).match(paragraph) ?? []) {
      const line = [...p.matchAll(words)].map((m) => decode(m[3]!)).join('').replace(/\s+/g, ' ').trim();
      if (line) out.push(line.length > 160 ? `${line.slice(0, 157)}…` : line);
      if (out.length === count) return out;
    }
  }
  return out;
};
