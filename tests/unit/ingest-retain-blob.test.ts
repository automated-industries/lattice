import { describe, it, expect } from 'vitest';
import { shouldRetainUploadBlob } from '../../src/gui/ingest-routes.js';

/**
 * Blob retention on upload. A browser drag-drop arrives as bytes with no local
 * path, so unless the upload route keeps the blob the original file is gone
 * after text extraction. Pre-fix only images/PDFs were retained, so a `.pptx` /
 * `.docx` / `.csv` lost its bytes and the file view could neither preview nor
 * download the underlying file. We now retain documents + media, while still
 * discarding arbitrary/unknown binaries.
 */
describe('shouldRetainUploadBlob — documents + media retain bytes, arbitrary binaries do not', () => {
  it('retains images and PDFs (unchanged from before)', () => {
    expect(shouldRetainUploadBlob('image/png', 'a.png')).toBe(true);
    expect(shouldRetainUploadBlob('image/jpeg', 'a.jpg')).toBe(true);
    expect(shouldRetainUploadBlob('application/pdf', 'a.pdf')).toBe(true);
  });

  it('retains office documents (OOXML, legacy MS Office, OpenDocument)', () => {
    expect(
      shouldRetainUploadBlob(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'deck.pptx',
      ),
    ).toBe(true);
    expect(
      shouldRetainUploadBlob(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'doc.docx',
      ),
    ).toBe(true);
    expect(
      shouldRetainUploadBlob(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'sheet.xlsx',
      ),
    ).toBe(true);
    expect(shouldRetainUploadBlob('application/msword', 'old.doc')).toBe(true);
    expect(shouldRetainUploadBlob('application/vnd.ms-excel', 'old.xls')).toBe(true);
    expect(shouldRetainUploadBlob('application/vnd.ms-powerpoint', 'old.ppt')).toBe(true);
    expect(shouldRetainUploadBlob('application/vnd.oasis.opendocument.text', 'open.odt')).toBe(
      true,
    );
    expect(
      shouldRetainUploadBlob('application/vnd.oasis.opendocument.spreadsheet', 'sheet.ods'),
    ).toBe(true);
    expect(shouldRetainUploadBlob('application/epub+zip', 'book.epub')).toBe(true);
  });

  it('retains text, csv, json, xml, yaml, rtf', () => {
    expect(shouldRetainUploadBlob('text/plain', 'n.txt')).toBe(true);
    expect(shouldRetainUploadBlob('text/markdown', 'n.md')).toBe(true);
    expect(shouldRetainUploadBlob('text/csv', 'data.csv')).toBe(true);
    expect(shouldRetainUploadBlob('application/json', 'x.json')).toBe(true);
    expect(shouldRetainUploadBlob('application/xml', 'x.xml')).toBe(true);
    expect(shouldRetainUploadBlob('application/x-yaml', 'x.yaml')).toBe(true);
    expect(shouldRetainUploadBlob('application/rtf', 'x.rtf')).toBe(true);
  });

  it('retains SVG and HTML (already served safely — the /blob route sandboxes inline bytes)', () => {
    // SVG matches the image/* prefix (it was retained before this change too);
    // HTML matches text/*. Both are served by the /blob route under a
    // `default-src 'none'; sandbox` CSP + `nosniff`, which blocks script/handler
    // execution — so retaining their bytes adds no execution surface.
    expect(shouldRetainUploadBlob('image/svg+xml', 'icon.svg')).toBe(true);
    expect(shouldRetainUploadBlob('text/html', 'page.html')).toBe(true);
  });

  it('retains audio and video', () => {
    expect(shouldRetainUploadBlob('audio/mpeg', 'a.mp3')).toBe(true);
    expect(shouldRetainUploadBlob('video/mp4', 'v.mp4')).toBe(true);
  });

  it('does NOT retain arbitrary / unknown binaries', () => {
    expect(shouldRetainUploadBlob('application/octet-stream', 'firmware.bin')).toBe(false);
    expect(shouldRetainUploadBlob('application/zip', 'archive.zip')).toBe(false);
    expect(shouldRetainUploadBlob('application/x-msdownload', 'setup.exe')).toBe(false);
  });

  it('rescues a generic content-type via the filename extension', () => {
    // A client that posts a known document as the catch-all octet-stream still
    // gets its bytes kept, recognized by the extension.
    expect(shouldRetainUploadBlob('application/octet-stream', 'report.docx')).toBe(true);
    expect(shouldRetainUploadBlob('', 'photo.png')).toBe(true);
    // …but a truly unknown payload (no helpful type or extension) is discarded.
    expect(shouldRetainUploadBlob('application/octet-stream', 'mystery')).toBe(false);
  });

  it('normalizes a content-type with parameters / casing', () => {
    expect(shouldRetainUploadBlob('application/json; charset=utf-8', 'x.json')).toBe(true);
    expect(shouldRetainUploadBlob('text/csv; charset=utf-8', 'data.csv')).toBe(true);
    expect(shouldRetainUploadBlob('TEXT/CSV', 'data.csv')).toBe(true);
    expect(shouldRetainUploadBlob('Application/PDF', 'a.pdf')).toBe(true);
  });
});
