import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFile } from '../../src/gui/ai/extract.js';
import { extractDocument } from '../../src/gui/ai/doc-extractors.js';

/**
 * Native document text extraction (no external markitdown CLI). Each fixture is
 * a minimal but real file of its format, generated with known text, so these
 * prove end-to-end that a dragged document extracts its content in-process.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeFixture(name: string, data: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-docx-'));
  dirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}
function fromB64(name: string, b64: string): string {
  return writeFixture(name, Buffer.from(b64, 'base64'));
}

// ── Fixtures (minimal valid files generated with known text) ──
const DOCX_B64 =
  'UEsDBBQAAAAAAAAAAADJTxqwrgEAAK4BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPjxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii93b3JkL2RvY3VtZW50LnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLmRvY3VtZW50Lm1haW4reG1sIi8+PC9UeXBlcz5QSwMEFAAAAAAAAAAAALmBRHEqAQAAKgEAAAsAAABfcmVscy8ucmVsczw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ3b3JkL2RvY3VtZW50LnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAAG8UJrNAAQAAQAEAABEAAAB3b3JkL2RvY3VtZW50LnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPHc6ZG9jdW1lbnQgeG1sbnM6dz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluIj48dzpib2R5Pjx3OnA+PHc6cj48dzp0PlRoZSBxdWljayBicm93biBmb3gganVtcHMgb3ZlciB0aGUgbGF6eSBkb2cuPC93OnQ+PC93OnI+PC93OnA+PHc6cD48dzpyPjx3OnQ+U2Vjb25kIHBhcmFncmFwaCBvZiB0aGUgcG9ydGZvbGlvIHJldmlldy48L3c6dD48L3c6cj48L3c6cD48L3c6Ym9keT48L3c6ZG9jdW1lbnQ+UEsBAhQAFAAAAAAAAAAAAMlPGrCuAQAArgEAABMAAAAAAAAAAAAAAAAAAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAUAAAAAAAAAAAAuYFEcSoBAAAqAQAACwAAAAAAAAAAAAAAAADfAQAAX3JlbHMvLnJlbHNQSwECFAAUAAAAAAAAAAAAbxQms0ABAABAAQAAEQAAAAAAAAAAAAAAAAAyAwAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAoQQAAAAA';

const PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1OCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoSGVsbG8gbmF0aXZlIFBERiBleHRyYWN0aW9uKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM0OSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxOQolJUVPRg==';

const PPTX_B64 =
  'UEsDBBQAAAAAAAAAAAAd9GMSugAAALoAAAAVAAAAcHB0L3NsaWRlcy9zbGlkZTEueG1sPD94bWwgdmVyc2lvbj0iMS4wIj8+PHA6c2xkIHhtbG5zOmE9IngiPjxwOmNTbGQ+PHA6c3BUcmVlPjxhOnA+PGE6cj48YTp0PlJvYWRtYXAgUTMgUGxhbm5pbmc8L2E6dD48L2E6cj48L2E6cD48YTpwPjxhOnI+PGE6dD5TaGlwIHRoZSBwYXJzZXI8L2E6dD48L2E6cj48L2E6cD48L3A6c3BUcmVlPjwvcDpjU2xkPjwvcDpzbGQ+UEsDBBQAAAAAAAAAAABiMg1icwAAAHMAAAAVAAAAcHB0L3NsaWRlcy9zbGlkZTIueG1sPD94bWwgdmVyc2lvbj0iMS4wIj8+PHA6c2xkIHhtbG5zOmE9IngiPjxwOmNTbGQ+PHA6c3BUcmVlPjxhOnQ+U2Vjb25kIHNsaWRlIG5vdGVzPC9hOnQ+PC9wOnNwVHJlZT48L3A6Y1NsZD48L3A6c2xkPlBLAQIUABQAAAAAAAAAAAAd9GMSugAAALoAAAAVAAAAAAAAAAAAAAAAAAAAAABwcHQvc2xpZGVzL3NsaWRlMS54bWxQSwECFAAUAAAAAAAAAAAAYjINYnMAAABzAAAAFQAAAAAAAAAAAAAAAADtAAAAcHB0L3NsaWRlcy9zbGlkZTIueG1sUEsFBgAAAAACAAIAhgAAAJMBAAAAAA==';

const XLSX_B64 =
  'UEsDBBQAAAAAAAAAAAC9RNBNYAAAAGAAAAAUAAAAeGwvc2hhcmVkU3RyaW5ncy54bWw8P3htbCB2ZXJzaW9uPSIxLjAiPz48c3N0PjxzaT48dD5SZWdpb248L3Q+PC9zaT48c2k+PHQ+U2FsZXM8L3Q+PC9zaT48c2k+PHQ+Tm9ydGg8L3Q+PC9zaT48L3NzdD5QSwMEFAAAAAAAAAAAANTiZN7SAAAA0gAAABgAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWw8P3htbCB2ZXJzaW9uPSIxLjAiPz48d29ya3NoZWV0PjxzaGVldERhdGE+PHJvdyByPSIxIj48YyByPSJBMSIgdD0icyI+PHY+MDwvdj48L2M+PGMgcj0iQjEiIHQ9InMiPjx2PjE8L3Y+PC9jPjwvcm93Pjxyb3cgcj0iMiI+PGMgcj0iQTIiIHQ9InMiPjx2PjI8L3Y+PC9jPjxjIHI9IkIyIj48dj4xMjAwPC92PjwvYz48L3Jvdz48L3NoZWV0RGF0YT48L3dvcmtzaGVldD5QSwECFAAUAAAAAAAAAAAAvUTQTWAAAABgAAAAFAAAAAAAAAAAAAAAAAAAAAAAeGwvc2hhcmVkU3RyaW5ncy54bWxQSwECFAAUAAAAAAAAAAAA1OJk3tIAAADSAAAAGAAAAAAAAAAAAAAAAACSAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsFBgAAAAACAAIAiAAAAJoBAAAAAA==';

const ODT_B64 =
  'UEsDBBQAAAAAAAAAAABexjIMJwAAACcAAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi92bmQub2FzaXMub3BlbmRvY3VtZW50LnRleHRQSwMEFAAAAAAAAAAAANMDmqwSAQAAEgEAAAsAAABjb250ZW50LnhtbDw/eG1sIHZlcnNpb249IjEuMCI/PjxvZmZpY2U6ZG9jdW1lbnQtY29udGVudCB4bWxuczpvZmZpY2U9Im8iIHhtbG5zOnRleHQ9InQiPjxvZmZpY2U6Ym9keT48b2ZmaWNlOnRleHQ+PHRleHQ6aD5Qcm9qZWN0IENoYXJ0ZXI8L3RleHQ6aD48dGV4dDpwPlRoZSBnb2FsIGlzIHRleHQgZXh0cmFjdGlvbi48L3RleHQ6cD48dGV4dDpwPlNlY29uZCBwYXJhZ3JhcGggaGVyZS48L3RleHQ6cD48L29mZmljZTp0ZXh0Pjwvb2ZmaWNlOmJvZHk+PC9vZmZpY2U6ZG9jdW1lbnQtY29udGVudD5QSwECFAAUAAAAAAAAAAAAXsYyDCcAAAAnAAAACAAAAAAAAAAAAAAAAAAAAAAAbWltZXR5cGVQSwECFAAUAAAAAAAAAAAA0wOarBIBAAASAQAACwAAAAAAAAAAAAAAAABNAAAAY29udGVudC54bWxQSwUGAAAAAAIAAgBvAAAAiAEAAAAA';

const ODP_B64 =
  'UEsDBBQAAAAAAAAAAAAzJqyoLwAAAC8AAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi92bmQub2FzaXMub3BlbmRvY3VtZW50LnByZXNlbnRhdGlvblBLAwQUAAAAAAAAAAAAWR1EkQcBAAAHAQAACwAAAGNvbnRlbnQueG1sPD94bWwgdmVyc2lvbj0iMS4wIj8+PG9mZmljZTpkb2N1bWVudC1jb250ZW50IHhtbG5zOm9mZmljZT0ibyIgeG1sbnM6dGV4dD0idCI+PG9mZmljZTpib2R5PjxvZmZpY2U6cHJlc2VudGF0aW9uPjxkcmF3OnBhZ2U+PHRleHQ6cD5TbGlkZSBkZWNrIHRpdGxlPC90ZXh0OnA+PHRleHQ6cD5LZXkgYnVsbGV0IHBvaW50PC90ZXh0OnA+PC9kcmF3OnBhZ2U+PC9vZmZpY2U6cHJlc2VudGF0aW9uPjwvb2ZmaWNlOmJvZHk+PC9vZmZpY2U6ZG9jdW1lbnQtY29udGVudD5QSwECFAAUAAAAAAAAAAAAMyasqC8AAAAvAAAACAAAAAAAAAAAAAAAAAAAAAAAbWltZXR5cGVQSwECFAAUAAAAAAAAAAAAWR1EkQcBAAAHAQAACwAAAAAAAAAAAAAAAABVAAAAY29udGVudC54bWxQSwUGAAAAAAIAAgBvAAAAhQEAAAAA';

const ODS_B64 =
  'UEsDBBQAAAAAAAAAAACFbDmKLgAAAC4AAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi92bmQub2FzaXMub3BlbmRvY3VtZW50LnNwcmVhZHNoZWV0UEsDBBQAAAAAAAAAAADOWSa3BgIAAAYCAAALAAAAY29udGVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiPz48b2ZmaWNlOmRvY3VtZW50LWNvbnRlbnQgeG1sbnM6b2ZmaWNlPSJvIiB4bWxuczp0ZXh0PSJ0IiB4bWxuczp0YWJsZT0idGIiPjxvZmZpY2U6Ym9keT48b2ZmaWNlOnNwcmVhZHNoZWV0Pjx0YWJsZTp0YWJsZT48dGFibGU6dGFibGUtcm93Pjx0YWJsZTp0YWJsZS1jZWxsPjx0ZXh0OnA+SXRlbTwvdGV4dDpwPjwvdGFibGU6dGFibGUtY2VsbD48dGFibGU6dGFibGUtY2VsbD48dGV4dDpwPlF0eTwvdGV4dDpwPjwvdGFibGU6dGFibGUtY2VsbD48L3RhYmxlOnRhYmxlLXJvdz48dGFibGU6dGFibGUtcm93Pjx0YWJsZTp0YWJsZS1jZWxsPjx0ZXh0OnA+V2lkZ2V0czwvdGV4dDpwPjwvdGFibGU6dGFibGUtY2VsbD48dGFibGU6dGFibGUtY2VsbD48dGV4dDpwPjQyPC90ZXh0OnA+PC90YWJsZTp0YWJsZS1jZWxsPjwvdGFibGU6dGFibGUtcm93PjwvdGFibGU6dGFibGU+PC9vZmZpY2U6c3ByZWFkc2hlZXQ+PC9vZmZpY2U6Ym9keT48L29mZmljZTpkb2N1bWVudC1jb250ZW50PlBLAQIUABQAAAAAAAAAAACFbDmKLgAAAC4AAAAIAAAAAAAAAAAAAAAAAAAAAABtaW1ldHlwZVBLAQIUABQAAAAAAAAAAADOWSa3BgIAAAYCAAALAAAAAAAAAAAAAAAAAFQAAABjb250ZW50LnhtbFBLBQYAAAAAAgACAG8AAACDAgAAAAA=';

const EPUB_B64 =
  'UEsDBBQAAAAAAAAAAABvYassFAAAABQAAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi9lcHViK3ppcFBLAwQUAAAAAAAAAAAA0GuYXZcAAACXAAAAFgAAAE1FVEEtSU5GL2NvbnRhaW5lci54bWw8P3htbCB2ZXJzaW9uPSIxLjAiPz48Y29udGFpbmVyPjxyb290ZmlsZXM+PHJvb3RmaWxlIGZ1bGwtcGF0aD0iT0VCUFMvY29udGVudC5vcGYiIG1lZGlhLXR5cGU9ImFwcGxpY2F0aW9uL29lYnBzLXBhY2thZ2UreG1sIi8+PC9yb290ZmlsZXM+PC9jb250YWluZXI+UEsDBBQAAAAAAAAAAAAAvwOl/AAAAPwAAAARAAAAT0VCUFMvY29udGVudC5vcGY8P3htbCB2ZXJzaW9uPSIxLjAiPz48cGFja2FnZT48bWFuaWZlc3Q+PGl0ZW0gaWQ9ImMxIiBocmVmPSJjaDEueGh0bWwiIG1lZGlhLXR5cGU9ImFwcGxpY2F0aW9uL3hodG1sK3htbCIvPjxpdGVtIGlkPSJjMiIgaHJlZj0iY2gyLnhodG1sIiBtZWRpYS10eXBlPSJhcHBsaWNhdGlvbi94aHRtbCt4bWwiLz48L21hbmlmZXN0PjxzcGluZT48aXRlbXJlZiBpZHJlZj0iYzEiLz48aXRlbXJlZiBpZHJlZj0iYzIiLz48L3NwaW5lPjwvcGFja2FnZT5QSwMEFAAAAAAAAAAAAF6RDzRXAAAAVwAAAA8AAABPRUJQUy9jaDEueGh0bWw8aHRtbD48Ym9keT48aDE+Q2hhcHRlciBPbmU8L2gxPjxwPkl0IHdhcyBhIGJyaWdodCBjb2xkIGRheSBpbiBBcHJpbC48L3A+PC9ib2R5PjwvaHRtbD5QSwMEFAAAAAAAAAAAAAKdLGFXAAAAVwAAAA8AAABPRUJQUy9jaDIueGh0bWw8aHRtbD48Ym9keT48aDE+Q2hhcHRlciBUd288L2gxPjxwPlRoZSBjbG9ja3Mgd2VyZSBzdHJpa2luZyB0aGlydGVlbi48L3A+PC9ib2R5PjwvaHRtbD5QSwECFAAUAAAAAAAAAAAAb2GrLBQAAAAUAAAACAAAAAAAAAAAAAAAAAAAAAAAbWltZXR5cGVQSwECFAAUAAAAAAAAAAAA0GuYXZcAAACXAAAAFgAAAAAAAAAAAAAAAAA6AAAATUVUQS1JTkYvY29udGFpbmVyLnhtbFBLAQIUABQAAAAAAAAAAAAAvwOl/AAAAPwAAAARAAAAAAAAAAAAAAAAAAUBAABPRUJQUy9jb250ZW50Lm9wZlBLAQIUABQAAAAAAAAAAABekQ80VwAAAFcAAAAPAAAAAAAAAAAAAAAAADACAABPRUJQUy9jaDEueGh0bWxQSwECFAAUAAAAAAAAAAAAAp0sYVcAAABXAAAADwAAAAAAAAAAAAAAAAC0AgAAT0VCUFMvY2gyLnhodG1sUEsFBgAAAAAFAAUAMwEAADgDAAAAAA==';

const RTF_RAW =
  '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}{\\colortbl;\\red0\\green0\\blue0;}\\f0\\fs24 Hello \\b world\\b0 .\\par Second line with caf\\u233?e accent.\\par}';

describe('native document extraction', () => {
  it('extracts a .docx (mammoth)', async () => {
    const r = await parseFile(fromB64('a.docx', DOCX_B64), undefined, 'a.docx');
    expect(r.skip).toBeUndefined();
    expect(r.text).toContain('quick brown fox');
    expect(r.text).toContain('portfolio review');
  });

  it('extracts a .pdf (unpdf, no native/canvas deps)', async () => {
    const r = await parseFile(fromB64('a.pdf', PDF_B64), 'application/pdf', 'a.pdf');
    expect(r.skip).toBeUndefined();
    expect(r.text).toContain('Hello native PDF extraction');
  });

  it('extracts a .pptx across slides', async () => {
    const r = await parseFile(fromB64('a.pptx', PPTX_B64), undefined, 'a.pptx');
    expect(r.skip).toBeUndefined();
    expect(r.text).toContain('Roadmap Q3 Planning');
    expect(r.text).toContain('Ship the parser');
    expect(r.text).toContain('Second slide notes');
  });

  it('extracts a .xlsx (shared strings + numeric cells)', async () => {
    const r = await parseFile(fromB64('a.xlsx', XLSX_B64), undefined, 'a.xlsx');
    expect(r.skip).toBeUndefined();
    expect(r.text).toContain('Region');
    expect(r.text).toContain('North');
    expect(r.text).toContain('1200'); // numeric cell, not a shared string
  });

  it('extracts a .odt (paragraphs + headings)', async () => {
    const r = await parseFile(fromB64('a.odt', ODT_B64), undefined, 'a.odt');
    expect(r.skip).toBeUndefined();
    expect(r.text).toContain('Project Charter');
    expect(r.text).toContain('text extraction');
  });

  it('extracts a .odp (presentation text)', async () => {
    const r = await parseFile(fromB64('a.odp', ODP_B64), undefined, 'a.odp');
    expect(r.skip).toBeUndefined();
    expect(r.text).toContain('Slide deck title');
    expect(r.text).toContain('Key bullet point');
  });

  it('extracts a .ods (spreadsheet cell text)', async () => {
    const r = await parseFile(fromB64('a.ods', ODS_B64), undefined, 'a.ods');
    expect(r.skip).toBeUndefined();
    expect(r.text).toContain('Widgets');
    expect(r.text).toContain('42');
  });

  it('extracts a .epub in spine order', async () => {
    const r = await parseFile(fromB64('a.epub', EPUB_B64), undefined, 'a.epub');
    expect(r.skip).toBeUndefined();
    expect(r.text).toContain('Chapter One');
    expect(r.text).toContain('bright cold day');
    expect(r.text).toContain('striking thirteen');
    expect(r.text.indexOf('Chapter One')).toBeLessThan(r.text.indexOf('Chapter Two'));
  });

  it('extracts a .rtf (de-RTF: groups stripped, unicode decoded)', async () => {
    const r = await parseFile(writeFixture('a.rtf', RTF_RAW), undefined, 'a.rtf');
    expect(r.skip).toBeUndefined();
    expect(r.text).toContain('Hello');
    expect(r.text).toContain('world');
    expect(r.text).toContain('Second line');
    expect(r.text).toContain('café'); // \u233? decoded, fallback char skipped
    expect(r.text).not.toContain('fonttbl'); // control destinations stripped
    expect(r.text).not.toContain('Times New Roman');
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
    // These extensions have no native extractor; extractDocument returns null
    // and parseFile reports skip — the file is still referenced.
    expect(await extractDocument('/whatever.xls', '.xls')).toBeNull();
    expect(await extractDocument('/whatever.ppt', '.ppt')).toBeNull();
    const r = await parseFile(
      writeFixture('legacy.xls', 'OLE2 binary stub'),
      undefined,
      'legacy.xls',
    );
    expect(r.skip).toBe(true);
  });
});
