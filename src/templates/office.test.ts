import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { clean, inspect, placeholder, sample } from './office.js';

/* Small but real-shaped Office files, built in memory. */

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

const CORE = `<cp:coreProperties xmlns:cp="c" xmlns:dc="d"><dc:title>Acme proposal</dc:title><dc:creator>Jane Doe</dc:creator><cp:lastModifiedBy>Jane Doe</cp:lastModifiedBy></cp:coreProperties>`;

const docx = (extra: Record<string, string> = {}) =>
  Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      'docProps/core.xml': strToU8(CORE),
      'docProps/app.xml': strToU8('<Properties><Pages>3</Pages><Company>Acme Ltd</Company></Properties>'),
      'word/document.xml': strToU8(
        '<w:document><w:body>' +
          '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Acme Holdings</w:t></w:r><w:r><w:t xml:space="preserve"> Proposal</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Call 020 7946 0958 &amp; ask for JANE.</w:t></w:r></w:p>' +
          '<w:p><w:ins w:author="Jane Doe"><w:r><w:t>Added</w:t></w:r></w:ins></w:p>' +
          '</w:body></w:document>',
      ),
      'word/_rels/document.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://acme.example/clients/secret" TargetMode="External"/></Relationships>',
      ),
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])),
    }),
  );

const pptx = () =>
  Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:r><a:t>Quarterly results</a:t></a:r></a:p></p:sld>'),
      'ppt/slides/slide2.xml': strToU8('<p:sld><a:p><a:r><a:t>Revenue up</a:t></a:r></a:p></p:sld>'),
    }),
  );

const xlsx = () =>
  Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      'xl/workbook.xml': strToU8('<workbook/>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>1250</v></c></row></sheetData></worksheet>'),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Client budget</t></si></sst>'),
    }),
  );

const part = (bytes: Buffer, name: string) => strFromU8(unzipSync(bytes)[name]!);

describe('inspect', () => {
  it('recognises each format from its contents and counts its length', () => {
    assert.deepEqual(inspect(docx(), 'Proposal.docx'), { format: 'docx', length: 3 });
    assert.deepEqual(inspect(pptx(), 'Deck.pptx'), { format: 'pptx', length: 2 });
    assert.deepEqual(inspect(xlsx(), 'Budget.xlsx'), { format: 'xlsx', length: 1 });
  });

  it('refuses files that are not Office documents', () => {
    assert.throws(() => inspect(Buffer.from('%PDF-1.7 not a zip'), 'file.docx'), { status: 415 });
    assert.throws(() => inspect(Buffer.from(zipSync({ 'hello.txt': strToU8('hi') })), 'file.docx'), { status: 415 });
  });

  it('refuses a file whose name disagrees with its contents', () => {
    assert.throws(() => inspect(docx(), 'Proposal.xlsx'), /is a \.docx file/);
  });

  it('refuses macros and embedded programs', () => {
    assert.throws(() => inspect(docx({ 'word/vbaProject.bin': 'x' }), 'p.docx'), /macros/);
    assert.throws(() => inspect(docx({ 'word/embeddings/oleObject1.bin': 'x' }), 'p.docx'), /macros/);
  });
});

describe('placeholder', () => {
  const result = placeholder(docx(), 'docx');
  const doc = part(result, 'word/document.xml');

  it('replaces every word and digit', () => {
    for (const secret of ['Acme', 'Holdings', 'Proposal', 'JANE', 'Added', '7946']) assert.ok(!doc.includes(secret), secret);
  });

  it('keeps the structure, styles and runs exactly', () => {
    const shape = (xml: string) => xml.replace(/>[^<]*</g, '><');
    assert.equal(shape(doc), shape(part(docx(), 'word/document.xml')));
    assert.match(doc, /<w:pStyle w:val="Title"\/>/);
    assert.match(doc, /<w:t xml:space="preserve"> [A-Z][a-z]+<\/w:t>/, 'leading space and capital kept');
  });

  it('keeps case, punctuation and escaping', () => {
    assert.match(doc, /<w:t>[A-Z][a-z]+ \d{3} \d{4} \d{4} &amp; [a-z]+ [a-z]+ [A-Z]{2,}\.<\/w:t>/);
  });

  it('is the same every time for the same file', () => {
    assert.equal(part(placeholder(docx(), 'docx'), 'word/document.xml'), doc);
  });

  it('points external links somewhere neutral and clears the title', () => {
    assert.match(part(result, 'word/_rels/document.xml.rels'), /Target="https:\/\/example.com\/"/);
    assert.match(part(result, 'docProps/core.xml'), /<dc:title><\/dc:title>/);
  });

  it('works for presentations and spreadsheets, leaving numbers in cells alone', () => {
    assert.ok(!part(placeholder(pptx(), 'pptx'), 'ppt/slides/slide1.xml').includes('Quarterly'));
    const sheet = placeholder(xlsx(), 'xlsx');
    assert.ok(!part(sheet, 'xl/sharedStrings.xml').includes('Client'));
    assert.match(part(sheet, 'xl/worksheets/sheet1.xml'), /<v>1250<\/v>/);
  });
});

describe('clean', () => {
  const cleaned = clean(docx());

  it('removes the author, editor, company and revision names', () => {
    assert.match(part(cleaned, 'docProps/core.xml'), /<dc:creator><\/dc:creator><cp:lastModifiedBy><\/cp:lastModifiedBy>/);
    assert.match(part(cleaned, 'docProps/app.xml'), /<Company><\/Company>/);
    assert.match(part(cleaned, 'word/document.xml'), /w:author="Author"/);
  });

  it('leaves the words alone', () => {
    assert.match(part(cleaned, 'word/document.xml'), /Acme Holdings/);
  });
});

describe('sample', () => {
  it('reads the first paragraphs in order, joining runs', () => {
    assert.deepEqual(sample(docx(), 'docx'), ['Acme Holdings Proposal', 'Call 020 7946 0958 & ask for JANE.', 'Added']);
    assert.deepEqual(sample(pptx(), 'pptx'), ['Quarterly results', 'Revenue up']);
  });

  it('lines up with the placeholder version paragraph for paragraph', () => {
    assert.equal(sample(placeholder(docx(), 'docx'), 'docx').length, 3);
  });
});
