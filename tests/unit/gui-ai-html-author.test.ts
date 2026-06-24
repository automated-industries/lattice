import { describe, it, expect } from 'vitest';
import { generateHtmlFile, HTML_AUTHOR_MODEL } from '../../src/gui/ai/html-author.js';
import { DEFAULT_MODEL } from '../../src/gui/ai/chat.js';
import type { LlmClient, TurnParams } from '../../src/gui/ai/chat.js';

/** A fake client that returns a fixed reply and captures the turn it was given. */
function fakeClient(reply: string, capture?: (p: TurnParams) => void): LlmClient {
  return {
    runTurn(params: TurnParams) {
      capture?.(params);
      params.onText(reply); // exercise the streaming sink too
      return Promise.resolve({ stopReason: 'end_turn', text: reply, toolUses: [] });
    },
  };
}

describe('generateHtmlFile (delegated HTML authoring)', () => {
  it('returns the model HTML and uses the chat model + a large token budget, no tools', async () => {
    let seen: TurnParams | undefined;
    const client = fakeClient('<!doctype html><html><body>hi</body></html>', (p) => {
      seen = p;
    });
    const html = await generateHtmlFile({
      client,
      schema: 'tables: widgets(name)',
      spec: 'build a page',
    });
    expect(html).toContain('<!doctype html>');
    expect(seen?.model).toBe(HTML_AUTHOR_MODEL);
    expect(seen?.maxTokens ?? 0).toBeGreaterThan(4096);
    expect(seen?.tools).toEqual([]);
    // Both the schema and the spec reach the prompt so the page wires up real names.
    expect(String(seen?.messages?.[0]?.content)).toContain('tables: widgets(name)');
    expect(String(seen?.messages?.[0]?.content)).toContain('build a page');
  });

  // Regression: the author once hardcoded `claude-sonnet-4-6`, a model a connected
  // Claude *subscription* ("Connect with Claude") may not be entitled to. Every
  // authoring sub-call then returned `429 rate_limit_error` — even a one-token one —
  // so no HTML file ever built, on local AND cloud (it's auth/model-based, not
  // DB-based). The author MUST use the chat's own model so it works wherever the
  // chat works. (Verified live on a subscription: haiku-4-5 OK, sonnet-4-6 429.)
  it('authors with the chat model, not a hardcoded model the auth may lack', async () => {
    let seen: TurnParams | undefined;
    const client = fakeClient('<!doctype html><html><body>x</body></html>', (p) => {
      seen = p;
    });
    await generateHtmlFile({ client, schema: '', spec: 's' });
    expect(seen?.model).toBe(DEFAULT_MODEL);
    expect(seen?.model).not.toBe('claude-sonnet-4-6');
  });

  it('strips a ```html fence the model may wrap the document in', async () => {
    const fenced = '```html\n<!doctype html><html><body>x</body></html>\n```';
    const html = await generateHtmlFile({ client: fakeClient(fenced), schema: '', spec: 's' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('```');
  });

  it('accepts an HTML fragment without a doctype/html wrapper', async () => {
    const html = await generateHtmlFile({
      client: fakeClient('<section><canvas></canvas></section>'),
      schema: '',
      spec: 's',
    });
    expect(html).toContain('<canvas>');
  });

  it('includes the current HTML and the instruction when editing', async () => {
    let seen: TurnParams | undefined;
    const client = fakeClient('<html><body>edited</body></html>', (p) => {
      seen = p;
    });
    await generateHtmlFile({
      client,
      schema: '',
      spec: 'make the header blue',
      currentHtml: '<html><body>ORIGINAL_MARKER</body></html>',
    });
    const prompt = String(seen?.messages?.[0]?.content);
    expect(prompt).toContain('ORIGINAL_MARKER');
    expect(prompt).toContain('make the header blue');
  });

  it('throws (never a silent empty fallback) when the model returns non-HTML', async () => {
    await expect(
      generateHtmlFile({
        client: fakeClient('Sorry, I cannot do that right now.'),
        schema: '',
        spec: 's',
      }),
    ).rejects.toThrow(/HTML/i);
  });
});
