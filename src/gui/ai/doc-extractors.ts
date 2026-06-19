import { extractDocx, extractDoc, extractPdf, extractPptx, extractXlsx } from './doc/ooxml.js';
import { extractOdfText, extractOds } from './doc/odf.js';
import { extractEpub, extractRtf } from './doc/other.js';

/**
 * Extract text from a document by extension, natively (no external CLI). Returns
 * the extracted text, or `null` for an unsupported format, a missing parser
 * dependency, or any extraction failure — the caller degrades to a skip. Never
 * throws.
 */
export async function extractDocument(path: string, ext: string): Promise<string | null> {
  switch (ext) {
    case '.docx':
      return extractDocx(path);
    case '.doc':
      return extractDoc(path);
    case '.pdf':
      return extractPdf(path);
    case '.pptx':
      return extractPptx(path);
    case '.xlsx':
      return extractXlsx(path);
    case '.odt':
    case '.odp':
      return extractOdfText(path);
    case '.ods':
      return extractOds(path);
    case '.epub':
      return extractEpub(path);
    case '.rtf':
      return extractRtf(path);
    default:
      // Legacy binary .xls/.ppt (no clean pure-JS parser) and anything else.
      return null;
  }
}
