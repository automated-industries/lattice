import { describe, it, expect } from 'vitest';
import { curatedCatalog } from '../../src/connectors/prefab/curated.js';
import { normalizeMcpRegistry } from '../../src/connectors/prefab/mcp-registry.js';
import { normalizeSmithery } from '../../src/connectors/prefab/smithery.js';
import { mergeCatalog } from '../../src/connectors/prefab/merge.js';
import { monogramIcon, resolveIcon } from '../../src/connectors/prefab/icons.js';
import { PrefabCatalog } from '../../src/connectors/prefab/catalog.js';
import type { CatalogEntry } from '../../src/connectors/prefab/types.js';

/**
 * Prefab catalog: curated flagship entries (metadata only) merged with registry-sourced ones. The
 * provider returns curated SYNCHRONOUSLY (never blocked on the registry) and degrades to curated on
 * any fetch failure.
 */

describe('curatedCatalog', () => {
  it('lists the flagship services with pinned endpoints + scopes', () => {
    const ids = curatedCatalog().map((e) => e.id);
    expect(ids).toEqual(['atlassian', 'gmail', 'gcal', 'gdrive', 'slack', 'salesforce']);
    const atlassian = curatedCatalog().find((e) => e.id === 'atlassian')!;
    expect(atlassian.oneClick).toBe(true); // DCR — true one-click
    expect(atlassian.serverUrl).toMatch(/^https:\/\/mcp\.atlassian\.com/);
    const salesforce = curatedCatalog().find((e) => e.id === 'salesforce')!;
    expect(salesforce.needsClientCreds).toBe(true); // guided connect
    expect(salesforce.scope).toBe('api refresh_token'); // confirmed against the live metadata (not mcp_api)
    // Atlassian scopes match the server's advertised scopes_supported (no read:jira-user).
    expect(atlassian.scope).toContain('read:jira-work');
    expect(atlassian.scope).not.toContain('read:jira-user');
    // every curated icon is a self-authored data: monogram (no committed brand logos)
    for (const e of curatedCatalog()) expect(e.icon.startsWith('data:image/svg')).toBe(true);
  });
});

describe('normalizeMcpRegistry', () => {
  it('keeps only https remote servers and maps label/transport/icon', () => {
    const entries = normalizeMcpRegistry([
      {
        name: 'io.github.acme/weather',
        icons: [{ src: 'https://cdn.example.com/weather.png' }],
        remotes: [{ type: 'streamable-http', url: 'https://weather.example.com/mcp' }],
      },
      { name: 'local-only', remotes: [{ type: 'stdio', url: 'stdio://x' }] }, // dropped (not https)
      { name: 'no-remote' }, // dropped (no remotes)
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe('Weather');
    expect(entries[0]!.serverUrl).toBe('https://weather.example.com/mcp');
    expect(entries[0]!.transport).toBe('http');
    expect(entries[0]!.icon).toBe('https://cdn.example.com/weather.png'); // remote logo passed through
    expect(entries[0]!.source).toBe('registry');
  });

  it('falls back to a monogram when a registry entry has no icon', () => {
    const [e] = normalizeMcpRegistry([
      { name: 'plain', remotes: [{ type: 'sse', url: 'https://plain.example.com/sse' }] },
    ]);
    expect(e!.transport).toBe('sse');
    expect(e!.icon.startsWith('data:image/svg')).toBe(true);
  });
});

describe('normalizeSmithery', () => {
  it('maps a hosted deployment + iconUrl', () => {
    const [e] = normalizeSmithery([
      {
        qualifiedName: 'acme/notes',
        displayName: 'Acme Notes',
        iconUrl: 'https://smithery.example/notes.svg',
        connections: [{ type: 'http', deploymentUrl: 'https://notes.acme.example/mcp' }],
      },
    ]);
    expect(e!.serverUrl).toBe('https://notes.acme.example/mcp');
    expect(e!.icon).toBe('https://smithery.example/notes.svg');
    expect(e!.origin).toBe('smithery');
  });
});

describe('mergeCatalog', () => {
  const reg = (id: string, host: string, label: string): CatalogEntry => ({
    id,
    label,
    icon: monogramIcon(label),
    serverUrl: `https://${host}/mcp`,
    source: 'registry',
  });

  it('puts curated first, drops a registry entry that duplicates a curated host, and caps', () => {
    const curated = curatedCatalog();
    const registry = [
      reg('dup', 'mcp.slack.com', 'Slack Dup'), // same host as curated Slack → dropped
      reg('weather', 'weather.example.com', 'Weather'),
      reg('alpha', 'alpha.example.com', 'Alpha'),
    ];
    const merged = mergeCatalog(curated, registry);
    expect(merged.slice(0, curated.length).map((e) => e.id)).toEqual(curated.map((e) => e.id));
    expect(merged.some((e) => e.label === 'Slack Dup')).toBe(false);
    // registry entries sort alphabetically after curated
    const regLabels = merged.filter((e) => e.source === 'registry').map((e) => e.label);
    expect(regLabels).toEqual(['Alpha', 'Weather']);
  });

  it('respects the total cap', () => {
    const many = Array.from({ length: 100 }, (_, i) => reg(`r${i}`, `h${i}.example.com`, `R ${i}`));
    expect(mergeCatalog([], many, 10)).toHaveLength(10);
  });
});

describe('resolveIcon', () => {
  it('prefers an https logo, else a monogram', () => {
    expect(resolveIcon({ iconUrl: 'https://x/y.png', label: 'X' })).toBe('https://x/y.png');
    expect(resolveIcon({ iconUrl: 'http://insecure/y.png', label: 'X' }).startsWith('data:')).toBe(
      true,
    );
    expect(resolveIcon({ label: 'X' }).startsWith('data:')).toBe(true);
  });
});

describe('PrefabCatalog', () => {
  it('returns the curated set synchronously with no sources configured', () => {
    const cat = new PrefabCatalog();
    expect(cat.getEntries().map((e) => e.id)).toEqual(curatedCatalog().map((e) => e.id));
  });

  it('merges registry entries after a refresh', async () => {
    const source = () =>
      Promise.resolve([
        {
          id: 'weather',
          label: 'Weather',
          icon: monogramIcon('Weather'),
          serverUrl: 'https://weather.example.com/mcp',
          source: 'registry' as const,
        },
      ]);
    const cat = new PrefabCatalog({ sources: [source] });
    await cat.refresh();
    expect(cat.getEntries().some((e) => e.id === 'weather')).toBe(true);
    expect(cat.getEntries()[0]!.id).toBe('atlassian'); // curated still first
  });

  it('degrades to curated when a source rejects (never throws)', async () => {
    const cat = new PrefabCatalog({ sources: [() => Promise.reject(new Error('registry down'))] });
    await expect(cat.refresh()).resolves.toBeUndefined();
    expect(cat.getEntries().map((e) => e.id)).toEqual(curatedCatalog().map((e) => e.id));
  });

  it('does not fetch when disabled', () => {
    let called = 0;
    const cat = new PrefabCatalog({
      enabled: false,
      sources: [
        () => {
          called++;
          return Promise.resolve([]);
        },
      ],
    });
    cat.refreshInBackground();
    expect(called).toBe(0);
    expect(cat.getEntries().length).toBe(curatedCatalog().length);
  });
});
