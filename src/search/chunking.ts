/**
 * Text chunking for embedding.
 *
 * Embedding a whole row as one vector blurs many topics into a single point,
 * which loses precision and forces a retriever to send large units to the model.
 * Splitting text into smaller, semantically coherent chunks — each embedded
 * separately — raises precision@k and lets a retriever return a few small,
 * on-point units instead of one big one (fewer tokens to a correct answer).
 *
 * The default `semanticChunker` is dependency-free and boundary-aware: it packs
 * text up to a character budget, preferring to break at paragraph, then
 * sentence, then word boundaries, with optional overlap so context that
 * straddles a boundary is not lost. Bring your own {@link ChunkerFn} (e.g. a
 * token-aware or code-aware splitter) when the default heuristic isn't enough.
 */

/** A single chunk of source text with its character offsets in the original. */
export interface TextChunk {
  /** 0-based position of this chunk in the sequence. */
  index: number;
  /** The chunk text (already includes any leading overlap). */
  content: string;
  /** Inclusive start offset in the source string. */
  start: number;
  /** Exclusive end offset in the source string. */
  end: number;
}

/** Splits source text into ordered chunks. */
export type ChunkerFn = (text: string) => TextChunk[];

export interface SemanticChunkerOptions {
  /** Target maximum characters per chunk. Default 1000. */
  maxChars?: number;
  /**
   * Characters of trailing context to repeat at the start of the next chunk.
   * Default 0. Must be < maxChars.
   */
  overlap?: number;
  /**
   * Minimum chunk size — a trailing remainder smaller than this is merged into
   * the previous chunk rather than emitted on its own. Default 0.
   */
  minChars?: number;
}

/** Boundary regexes, tried strongest-first. */
const PARA = /\n\s*\n/g;
const SENTENCE = /(?<=[.!?])\s+/g;

/**
 * Find the best break offset at or before `hardEnd` (and after `from`),
 * preferring a paragraph break, then a sentence break, then whitespace. Returns
 * `hardEnd` when no softer boundary exists in the window (a hard split).
 */
function bestBreak(text: string, from: number, hardEnd: number): number {
  const window = text.slice(from, hardEnd);
  // Paragraph boundary: last one in the window.
  let lastPara = -1;
  PARA.lastIndex = 0;
  for (let m = PARA.exec(window); m; m = PARA.exec(window)) {
    lastPara = m.index + m[0].length;
  }
  if (lastPara > 0) return from + lastPara;

  // Sentence boundary.
  let lastSent = -1;
  SENTENCE.lastIndex = 0;
  for (let m = SENTENCE.exec(window); m; m = SENTENCE.exec(window)) {
    lastSent = m.index + m[0].length;
  }
  if (lastSent > 0) return from + lastSent;

  // Whitespace boundary.
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > 0) return from + lastSpace + 1;

  // No soft boundary — hard split at the budget.
  return hardEnd;
}

/**
 * Create a boundary-aware chunker. Empty/whitespace-only input yields no chunks.
 * Text shorter than `maxChars` yields a single chunk.
 */
export function semanticChunker(opts: SemanticChunkerOptions = {}): ChunkerFn {
  const maxChars = opts.maxChars ?? 1000;
  const overlap = opts.overlap ?? 0;
  const minChars = opts.minChars ?? 0;
  if (maxChars <= 0) throw new Error('semanticChunker: maxChars must be positive');
  if (overlap < 0 || overlap >= maxChars) {
    throw new Error('semanticChunker: overlap must be >= 0 and < maxChars');
  }

  return (text: string): TextChunk[] => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return [];
    if (text.length <= maxChars) {
      return [{ index: 0, content: text, start: 0, end: text.length }];
    }

    const chunks: TextChunk[] = [];
    let cursor = 0;
    let index = 0;
    while (cursor < text.length) {
      const hardEnd = Math.min(text.length, cursor + maxChars);
      let end = hardEnd >= text.length ? text.length : bestBreak(text, cursor, hardEnd);
      // Guard against zero-progress (boundary at cursor).
      if (end <= cursor) end = hardEnd;

      const content = text.slice(cursor, end);
      // Merge a too-small trailing remainder into the previous chunk.
      const prev = chunks[chunks.length - 1];
      if (
        minChars > 0 &&
        content.trim().length < minChars &&
        prev !== undefined &&
        end >= text.length
      ) {
        prev.content = text.slice(prev.start, end);
        prev.end = end;
        break;
      }

      chunks.push({ index, content, start: cursor, end });
      index++;

      if (end >= text.length) break;
      // Advance, applying overlap (never moving backwards past the prior cursor).
      const next = Math.max(cursor + 1, end - overlap);
      cursor = next;
    }
    return chunks;
  };
}

/**
 * Apply chunking to a piece of text using the table's config. When no chunker is
 * configured the whole text is one chunk (index 0) — the historical behavior.
 * A `contextPrefix` (e.g. a title or breadcrumb) is prepended to every chunk's
 * embedded content so each chunk carries enough context to be retrieved well.
 */
export function chunkText(
  text: string,
  chunker?: ChunkerFn,
  contextPrefix?: string,
): { chunkIndex: number; content: string }[] {
  if (text.length === 0) return [];
  const base = chunker ? chunker(text) : [{ index: 0, content: text, start: 0, end: text.length }];
  const prefix = contextPrefix && contextPrefix.length > 0 ? `${contextPrefix}\n\n` : '';
  return base.map((c) => ({ chunkIndex: c.index, content: `${prefix}${c.content}` }));
}
