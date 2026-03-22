import { describe, it, expect } from 'vitest';
import { interpolate } from '../../src/render/interpolate.js';

describe('interpolate()', () => {
  // -------------------------------------------------------------------------
  // Basic substitution
  // -------------------------------------------------------------------------

  it('replaces a single token', () => {
    expect(interpolate('Hello {{name}}!', { name: 'Alice' })).toBe('Hello Alice!');
  });

  it('replaces multiple tokens in one template', () => {
    expect(interpolate('{{first}} {{last}}', { first: 'Alice', last: 'Smith' })).toBe(
      'Alice Smith',
    );
  });

  it('replaces the same token used more than once', () => {
    expect(interpolate('{{x}} and {{x}}', { x: 'foo' })).toBe('foo and foo');
  });

  it('leaves literal text with no tokens unchanged', () => {
    expect(interpolate('no tokens here', { x: 1 })).toBe('no tokens here');
  });

  // -------------------------------------------------------------------------
  // Value coercion
  // -------------------------------------------------------------------------

  it('coerces numbers to string', () => {
    expect(interpolate('score: {{n}}', { n: 42 })).toBe('score: 42');
  });

  it('coerces booleans to string', () => {
    expect(interpolate('{{flag}}', { flag: false })).toBe('false');
  });

  it('renders null as empty string', () => {
    expect(interpolate('{{v}}', { v: null })).toBe('');
  });

  it('renders undefined as empty string', () => {
    expect(interpolate('{{v}}', { v: undefined })).toBe('');
  });

  // -------------------------------------------------------------------------
  // Unknown / missing paths
  // -------------------------------------------------------------------------

  it('renders unknown key as empty string', () => {
    expect(interpolate('{{missing}}', {})).toBe('');
  });

  // -------------------------------------------------------------------------
  // Dot-notation (nested objects — relation fields)
  // -------------------------------------------------------------------------

  it('resolves one level of dot notation', () => {
    expect(
      interpolate('{{author.name}}', {
        author: { name: 'Bob', id: 'u-1' },
      }),
    ).toBe('Bob');
  });

  it('resolves two levels of dot notation', () => {
    expect(
      interpolate('{{a.b.c}}', { a: { b: { c: 'deep' } } }),
    ).toBe('deep');
  });

  it('resolves sibling tokens on nested objects', () => {
    expect(
      interpolate('{{post.title}} by {{author.name}}', {
        post: { title: 'Hello World' },
        author: { name: 'Alice' },
      }),
    ).toBe('Hello World by Alice');
  });

  it('renders empty string when intermediate key is missing', () => {
    expect(interpolate('{{rel.name}}', {})).toBe('');
  });

  it('renders empty string when intermediate key is null', () => {
    expect(interpolate('{{rel.name}}', { rel: null })).toBe('');
  });

  it('renders empty string when leaf is null', () => {
    expect(interpolate('{{author.name}}', { author: { name: null } })).toBe('');
  });

  // -------------------------------------------------------------------------
  // Whitespace in token path
  // -------------------------------------------------------------------------

  it('trims whitespace in token path', () => {
    expect(interpolate('{{ name }}', { name: 'Alice' })).toBe('Alice');
  });

  it('trims whitespace in dot-notation path', () => {
    expect(interpolate('{{ author.name }}', { author: { name: 'Bob' } })).toBe('Bob');
  });
});
