import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { parseFile } from '../../src/gui/ai/extract.js';
import { extractDocument } from '../../src/gui/ai/doc-extractors.js';

/**
 * Native document text extraction (no external markitdown CLI). Fixtures are
 * minimal but real files of each format, built in-process, so these prove
 * end-to-end that a dragged document extracts its content — and that the
 * hardening (linear tag scanning, decompression caps, RTF/CP1252/run-join
 * correctness) holds against hostile/edge-case input.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeFixture(name: string, data: Buffer | Uint8Array | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-doc-'));
  dirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}
/** Build a real zip (OOXML/ODF/EPUB are all zips) from {entryName: xmlString}. */
function zipFile(name: string, files: Record<string, string>): string {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v);
  return writeFixture(name, zipSync(entries));
}

const XML = '<?xml version="1.0" encoding="UTF-8"?>';

// ── docx (mammoth) ──
const DOCX_DOCUMENT =
  `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  '<w:body><w:p><w:r><w:t>The quick brown fox jumps over the lazy dog.</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>Second paragraph of the portfolio review.</w:t></w:r></w:p></w:body></w:document>';
function docxFixture(): string {
  return zipFile('a.docx', {
    '[Content_Types].xml':
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': DOCX_DOCUMENT,
  });
}

// A minimal real text PDF (not a zip → embedded base64).
const PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1OCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoSGVsbG8gbmF0aXZlIFBERiBleHRyYWN0aW9uKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM0OSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxOQolJUVPRg==';

describe('native document extraction', () => {
  it('extracts a .docx (mammoth)', async () => {
    const r = await parseFile(docxFixture(), undefined, 'a.docx');
    expect(r.skip).toBeUndefined();
    expect(r.text).toContain('quick brown fox');
    expect(r.text).toContain('portfolio review');
  });

  it('extracts a .pdf (unpdf, no native/canvas deps)', async () => {
    const r = await parseFile(
      writeFixture('a.pdf', Buffer.from(PDF_B64, 'base64')),
      'application/pdf',
      'a.pdf',
    );
    expect(r.skip).toBeUndefined();
    expect(r.text).toContain('Hello native PDF extraction');
  });

  it('extracts a .pptx across slides', async () => {
    const p = zipFile('a.pptx', {
      'ppt/slides/slide1.xml':
        `${XML}<p:sld xmlns:a="x"><p:cSld><p:spTree>` +
        '<a:p><a:r><a:t>Roadmap Q3 Planning</a:t></a:r></a:p>' +
        '<a:p><a:r><a:t>Ship the parser</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>',
      'ppt/slides/slide2.xml': `${XML}<p:sld xmlns:a="x"><a:t>Second slide notes</a:t></p:sld>`,
    });
    const r = await parseFile(p, undefined, 'a.pptx');
    expect(r.text).toContain('Roadmap Q3 Planning');
    expect(r.text).toContain('Ship the parser');
    expect(r.text).toContain('Second slide notes');
  });

  it('joins split runs within a paragraph with no spurious space', async () => {
    // PowerPoint splits one visual word into multiple <a:t> runs at formatting
    // boundaries; joining with a space would yield "Port folio".
    const p = zipFile('split.pptx', {
      'ppt/slides/slide1.xml': `${XML}<p:sld xmlns:a="x"><a:p><a:r><a:t>Port</a:t></a:r><a:r><a:t>folio</a:t></a:r></a:p></p:sld>`,
    });
    const r = await parseFile(p, undefined, 'split.pptx');
    expect(r.text).toContain('Portfolio');
    expect(r.text).not.toContain('Port folio');
  });

  it('extracts a .xlsx (shared strings + numeric cells)', async () => {
    const p = zipFile('a.xlsx', {
      'xl/sharedStrings.xml': `${XML}<sst><si><t>Region</t></si><si><t>Sales</t></si><si><t>North</t></si></sst>`,
      'xl/worksheets/sheet1.xml':
        `${XML}<worksheet><sheetData>` +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row>' +
        '</sheetData></worksheet>',
    });
    const r = await parseFile(p, undefined, 'a.xlsx');
    expect(r.text).toContain('Region');
    expect(r.text).toContain('North');
    expect(r.text).toContain('1200'); // numeric cell, not a shared string
  });

  it('preserves shared-string slots across a self-closing <si/> (no index shift)', async () => {
    // A self-closing <si/> is an empty string entry; if its slot collapses, every
    // later index shifts and cells render a neighbour's text.
    const p = zipFile('si.xlsx', {
      'xl/sharedStrings.xml': `${XML}<sst><si><t>First</t></si><si/><si><t>Third</t></si></sst>`,
      'xl/worksheets/sheet1.xml':
        `${XML}<worksheet><sheetData><row r="1">` +
        '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row></sheetData></worksheet>',
    });
    const r = await parseFile(p, undefined, 'si.xlsx');
    expect(r.text).toContain('First');
    expect(r.text).toContain('Third'); // index 2 still maps to "Third"
  });

  it('extracts a .odt (paragraphs + headings, in document order)', async () => {
    const p = zipFile('a.odt', {
      'content.xml':
        `${XML}<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text>` +
        '<text:h>Project Charter</text:h><text:p>The goal is text extraction.</text:p>' +
        '<text:p>Second paragraph here.</text:p></office:text></office:body></office:document-content>',
    });
    const r = await parseFile(p, undefined, 'a.odt');
    expect(r.text).toContain('Project Charter');
    expect(r.text).toContain('text extraction');
    expect(r.text.indexOf('Project Charter')).toBeLessThan(r.text.indexOf('Second paragraph'));
  });

  it('extracts a .ods including a numeric cell stored only in office:value', async () => {
    const p = zipFile('a.ods', {
      'content.xml':
        `${XML}<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb">` +
        '<office:body><office:spreadsheet><table:table><table:table-row>' +
        '<table:table-cell><text:p>Revenue</text:p></table:table-cell>' +
        '<table:table-cell office:value-type="float" office:value="99000"><text:p/></table:table-cell>' +
        '</table:table-row></table:table></office:spreadsheet></office:body></office:document-content>',
    });
    const r = await parseFile(p, undefined, 'a.ods');
    expect(r.text).toContain('Revenue');
    expect(r.text).toContain('99000'); // value from the attribute, empty <text:p/>
  });

  it('extracts a .epub in spine order, resolving percent-encoded hrefs', async () => {
    const p = zipFile('a.epub', {
      'META-INF/container.xml': `${XML}<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      'OEBPS/content.opf':
        `${XML}<package><manifest>` +
        '<item id="c1" href="ch1.xhtml"/><item id="c2" href="ch%202.xhtml"/></manifest>' +
        '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
      'OEBPS/ch1.xhtml':
        '<html><body><h1>Chapter One</h1><p>It was a bright cold day.</p></body></html>',
      // entry name has a real space; the spine href is percent-encoded
      'OEBPS/ch 2.xhtml':
        '<html><body><h1>Chapter Two</h1><p>The clocks struck thirteen.</p></body></html>',
    });
    const r = await parseFile(p, undefined, 'a.epub');
    expect(r.text).toContain('bright cold day');
    expect(r.text).toContain('struck thirteen'); // percent-encoded chapter not dropped
    expect(r.text.indexOf('Chapter One')).toBeLessThan(r.text.indexOf('Chapter Two'));
  });

  it('extracts a .rtf: strips \\* destinations, decodes CP1252 punctuation', async () => {
    const rtf =
      '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}' +
      'Visit {\\field{\\*\\fldinst HYPERLINK "https://example.com/secret"}{\\fldrslt our site}} now.' +
      '\\par Smart \\u8220?quotes\\u8221? and an em\\u8212?dash.\\par}';
    const r = await parseFile(writeFixture('a.rtf', rtf), undefined, 'a.rtf');
    expect(r.text).toContain('Visit');
    expect(r.text).toContain('our site'); // \fldrslt (visible field result) kept
    expect(r.text).toContain('now');
    expect(r.text).toContain('“quotes”'); // curly quotes
    expect(r.text).toContain('em—dash'); // em dash
    // The \*\fldinst hyperlink destination must NOT leak into the body.
    expect(r.text).not.toMatch(/HYPERLINK|example\.com|fldinst/);
  });

  it("decodes \\'xx CP1252 high bytes (smart quotes / em dash), not Latin-1 controls", async () => {
    const rtf = "{\\rtf1\\ansi Smart \\'93quotes\\'94 and em\\'97dash.\\par}";
    const r = await parseFile(writeFixture('cp.rtf', rtf), undefined, 'cp.rtf');
    expect(r.text).toContain('“quotes”');
    expect(r.text).toContain('em—dash');
    expect(r.text).not.toMatch(/[\u0080-\u009f]/); // no raw C1 control chars leaked
  });

  it('degrades to skip for an invalid document (no throw)', async () => {
    const r = await parseFile(
      writeFixture('broken.docx', 'not a real docx'),
      undefined,
      'broken.docx',
    );
    expect(r.skip).toBe(true);
    expect(r.text).toBe('');
  });

  it('degrades to skip for legacy binary .xls / .ppt (no clean pure-JS parser)', async () => {
    expect(await extractDocument('/whatever.xls', '.xls')).toBeNull();
    expect(await extractDocument('/whatever.ppt', '.ppt')).toBeNull();
    const r = await parseFile(
      writeFixture('legacy.xls', 'OLE2 binary stub'),
      undefined,
      'legacy.xls',
    );
    expect(r.skip).toBe(true);
  });

  it('handles an unclosed-tag flood in linear time (ReDoS guard)', async () => {
    // ~150k unclosed <si> opening tags: a global lazy `<si>…</si>` regex would
    // rescan to EOF for each → O(n²) (seconds); the linear scanner stops at the
    // first missing close. Generous bound so only a quadratic regression trips it.
    const ss = `${XML}<sst><si><t>Marker</t></si>` + '<si>'.repeat(150_000) + '</sst>';
    const p = zipFile('flood.xlsx', {
      'xl/sharedStrings.xml': ss,
      'xl/worksheets/sheet1.xml': `${XML}<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>`,
    });
    const start = Date.now();
    const r = await parseFile(p, undefined, 'flood.xlsx');
    expect(Date.now() - start).toBeLessThan(3000);
    expect(r.text).toContain('Marker');
  });

  it('RTF: a destination group between a control word and body keeps the first body word', async () => {
    // `\ansi{\*\generator …}Body` must not fuse to `\ansiBody` (which the greedy
    // control-word stripper would then eat). WordPad/Word emit this routinely.
    const rtf = '{\\rtf1\\ansi{\\*\\generator Riched20 10.0.0;}Body text follows.\\par}';
    const r = await parseFile(writeFixture('gen.rtf', rtf), undefined, 'gen.rtf');
    expect(r.text).toContain('Body text follows');
    expect(r.text).not.toMatch(/Riched20|generator/);
  });

  it('helper scanners (stripElement / stripTags / odfWhitespace) stay linear on floods', async () => {
    // Each input is an unclosed-tag flood routed through a different helper; a
    // global lazy/greedy regex would be O(n²) (seconds). Bound is generous so
    // only a genuine quadratic regression trips it.
    const N = 100_000;
    const start = Date.now();

    // stripElement, via XLSX <rPh> (phonetic-guide) flood inside a shared string.
    const xlsx = zipFile('rph.xlsx', {
      'xl/sharedStrings.xml': `${XML}<sst><si><t>Marker</t>${'<rPh>'.repeat(N)}</si></sst>`,
      'xl/worksheets/sheet1.xml': `${XML}<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>`,
    });
    expect((await parseFile(xlsx, undefined, 'rph.xlsx')).text).toContain('Marker');

    // stripTags, via a PPTX <a:t> run holding a '<' flood.
    const pptx = zipFile('lt.pptx', {
      'ppt/slides/slide1.xml': `${XML}<p:sld xmlns:a="x"><a:p><a:t>Visible</a:t><a:t>${'<'.repeat(N)}</a:t></a:p></p:sld>`,
    });
    expect((await parseFile(pptx, undefined, 'lt.pptx')).text).toContain('Visible');

    // stripElement again, via EPUB <script> flood in an XHTML body (stripHtml).
    const epub = zipFile('s.epub', {
      'META-INF/container.xml': `${XML}<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>`,
      'c.opf': `${XML}<package><manifest><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>`,
      'a.xhtml': `<html><body><p>Readable</p>${'<script>'.repeat(N)}</body></html>`,
    });
    expect((await parseFile(epub, undefined, 's.epub')).text).toContain('Readable');

    // odfWhitespace, via ODT <text:s flood in a paragraph.
    const odt = zipFile('s.odt', {
      'content.xml':
        `${XML}<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text>` +
        `<text:p>Paragraph${'<text:s '.repeat(N)}</text:p></office:text></office:body></office:document-content>`,
    });
    expect((await parseFile(odt, undefined, 's.odt')).text).toContain('Paragraph');

    expect(Date.now() - start).toBeLessThan(4000);
  });

  it('EPUB OPF item/itemref scan stays linear on an <item> flood', async () => {
    // A trailing `<item ` flood with no closing '>' would make a lazy global
    // `/<item\b[^>]*?>/g` rescan to EOF per item → O(n²); eachElement breaks.
    const opf =
      `${XML}<package><manifest><item id="c1" href="c1.xhtml"/></manifest>` +
      `<spine><itemref idref="c1"/></spine></package>` +
      '<item '.repeat(120_000);
    const epub = zipFile('opfflood.epub', {
      'META-INF/container.xml': `${XML}<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>`,
      'c.opf': opf,
      'c1.xhtml': '<html><body><p>Readable body here</p></body></html>',
    });
    const start = Date.now();
    const r = await parseFile(epub, undefined, 'opfflood.epub');
    expect(Date.now() - start).toBeLessThan(3000);
    expect(r.text).toContain('Readable body here');
  });

  it('RTF whitespace collapse stays linear on a space-run flood', async () => {
    // 300k spaces not followed by a newline: a `/[ \t]+\n/g` with no prior
    // collapse backtracks O(n²); the leading collapse makes it linear.
    const rtf = '{\\rtf1 Start' + ' '.repeat(300_000) + 'End.\\par}';
    const start = Date.now();
    const r = await parseFile(writeFixture('spaces.rtf', rtf), undefined, 'spaces.rtf');
    expect(Date.now() - start).toBeLessThan(3000);
    expect(r.text).toContain('Start');
    expect(r.text).toContain('End');
  });

  it('RTF: a \\* destination mid-word does not insert a spurious space', async () => {
    // `Auto{\*\bkmkstart …}mation` — a bookmark inside a word. The separator must
    // only fire after a control word (`\ansi`), not between two body letters.
    const rtf = '{\\rtf1 Auto{\\*\\bkmkstart _Ref1}mation Tools.\\par}';
    const r = await parseFile(writeFixture('bkmk.rtf', rtf), undefined, 'bkmk.rtf');
    expect(r.text).toContain('Automation Tools');
    expect(r.text).not.toContain('Auto mation');
  });

  it('RTF: \\tab delimiters survive the whitespace collapse', async () => {
    const rtf = '{\\rtf1 Col1\\tab Col2\\tab Col3\\par}';
    const r = await parseFile(writeFixture('tabs.rtf', rtf), undefined, 'tabs.rtf');
    expect(r.text).toContain('Col1\tCol2\tCol3'); // tabs kept, not flattened to spaces
  });
});
