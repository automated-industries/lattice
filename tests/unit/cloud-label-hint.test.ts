// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { normalizeLabel } from '../../src/framework/db-pointer.js';

/**
 * The Label field says what it does with what you type.
 *
 * Typing "Strategy Team" used to come back as an error about the credentials.
 * It is accepted now — hyphenated into the key the connection is stored under —
 * but a name silently changing shape is its own small confusion, so the field
 * carries one sentence saying so.
 *
 * The sentence is only worth anything if it is TRUE, so this checks both halves
 * together: the shipped form (sliced out of the composed application script, not
 * a copy of it) renders a hint attached to the Label field, and the behavior it
 * describes is the behavior normalizeLabel actually has.
 */

/** The shipped `postgresFormHtml`, taken verbatim out of the composed script. */
function renderShippedForm(): HTMLElement {
  const from = appJs.indexOf('function postgresFormHtml');
  const to = appJs.indexOf('function readPostgresWizardForm');
  expect(from, 'found the Postgres form builder in the app script').toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);

  const w = globalThis as unknown as Record<string, unknown>;
  const ENTITIES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  w.escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
  (0, eval)(`${appJs.slice(from, to)}\nglobalThis.__shippedForm = postgresFormHtml;`);
  const html = (w.__shippedForm as (p?: unknown) => string)({});
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe('the Label field explains itself', () => {
  let host: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    host = renderShippedForm();
  });

  it('renders a hint attached to the Label field, not floating elsewhere in the form', () => {
    const label = host.querySelector('#w-label');
    expect(label, 'the Label input is there').not.toBeNull();
    const hint = host.querySelector('#w-label-hint');
    expect(hint, 'and it has a hint').not.toBeNull();
    // Same field group as the input — a hint under the Password box would be
    // technically present and useless.
    expect(hint!.parentElement).toBe(label!.parentElement);
    expect(hint!.textContent?.trim()).not.toBe('');
  });

  it('no other field grew a hint — this is about the one that surprised people', () => {
    expect(host.querySelectorAll('.hint')).toHaveLength(1);
  });

  it('what the hint claims is what the label actually does', () => {
    const text = host.querySelector('#w-label-hint')!.textContent!.toLowerCase();
    // It promises the substitution rather than a rejection.
    expect(text).toContain('dash');
    expect(text, 'it does not threaten an error it will not produce').not.toContain('invalid');
    expect(text).not.toContain('required');

    // And the promise holds: a space becomes a dash, punctuation becomes a dash,
    // and nothing is refused for having them.
    expect(normalizeLabel('Strategy Team')).toBe('Strategy-Team');
    expect(normalizeLabel('Q1 2026 / Revenue!!')).toBe('Q1-2026-Revenue');
    expect(normalizeLabel('already-fine_1.0')).toBe('already-fine_1.0');
  });
});
