import { describe, it, expect } from 'vitest';
import {
  requiredArgs,
  argEntityToken,
  resolveArgBindings,
} from '../../src/connectors/mcp/arg-resolver.js';
import type { JsonSchemaLike } from '../../src/connectors/mcp/schema-compile.js';
import type { McpKindDesc } from '../../src/connectors/mcp/schema-cache.js';

/**
 * Two-phase arg resolution: a parameterized read tool's required args bind to enum/default values,
 * a discovery kind's rows, operator context, or stay unresolved. Exactly one discovery binding →
 * a single-level parent fan-out; two+ → no cross-product crawl.
 */

const kind = (k: string, naturalKey: string): McpKindDesc => ({
  kind: k,
  tool: `list_${k}`,
  columns: [],
  naturalKey,
});

describe('requiredArgs', () => {
  it('reads inputSchema.required with each arg schema', () => {
    const input: JsonSchemaLike = {
      type: 'object',
      properties: { cloudId: { type: 'string' }, jql: { type: 'string' } },
      required: ['cloudId', 'jql'],
    };
    const args = requiredArgs(input);
    expect(args.map((a) => a.name)).toEqual(['cloudId', 'jql']);
    expect(args[0].schema.type).toBe('string');
  });

  it('returns [] for a no-arg or schemaless tool', () => {
    expect(requiredArgs(undefined)).toEqual([]);
    expect(requiredArgs({ type: 'object', properties: {} })).toEqual([]);
  });
});

describe('argEntityToken', () => {
  it('normalizes id-shaped arg names to an entity token + aliases', () => {
    expect(argEntityToken('cloudId')?.token).toBe('cloud');
    expect(argEntityToken('cloudId')?.aliases).toContain('resource');
    expect(argEntityToken('workspaceId')?.token).toBe('workspace');
    expect(argEntityToken('channel_id')?.token).toBe('channel');
  });

  it('returns null for a non-id arg', () => {
    expect(argEntityToken('jql')).toBeNull();
    expect(argEntityToken('query')).toBeNull();
  });
});

describe('resolveArgBindings', () => {
  it('binds a cloudId to a sites discovery kind and fans out over it', () => {
    // A no-arg discovery kind keyed by cloud_id (mirrors Atlassian getAccessibleAtlassianResources).
    const discovery = [kind('sites', 'cloud_id')];
    const { argBindings, parentKind } = resolveArgBindings(
      {
        kind: 'jira_issues',
        tool: 'searchJiraIssuesUsingJql',
        input: {
          type: 'object',
          properties: {
            cloudId: { type: 'string' },
            jql: { type: 'string', default: 'ORDER BY updated DESC' },
          },
          required: ['cloudId', 'jql'],
        },
      },
      discovery,
    );
    expect(parentKind).toBe('sites');
    const cloud = argBindings.find((b) => b.arg === 'cloudId')!;
    expect(cloud.via).toBe('discovery');
    expect(cloud.sourceKind).toBe('sites');
    expect(cloud.sourceField).toBe('cloud_id');
    // jql has a default → statically bound, no discovery needed
    expect(argBindings.find((b) => b.arg === 'jql')!.via).toBe('default');
  });

  it('binds a bounded enum arg and leaves an open-domain arg unresolved', () => {
    const { argBindings, parentKind } = resolveArgBindings(
      {
        kind: 't',
        tool: 'list_t',
        input: {
          type: 'object',
          properties: { status: { enum: ['open', 'closed'] }, projectId: { type: 'string' } },
          required: ['status', 'projectId'],
        },
      },
      [], // no discovery kinds
    );
    expect(parentKind).toBeUndefined();
    expect(argBindings.find((b) => b.arg === 'status')!.via).toBe('enum');
    const proj = argBindings.find((b) => b.arg === 'projectId')!;
    expect(proj.via).toBe('unresolved');
    expect(proj.reason).toBeTruthy();
  });

  it('binds an open-domain arg to operator context when provided', () => {
    const { argBindings } = resolveArgBindings(
      {
        kind: 't',
        tool: 'list_t',
        input: { type: 'object', properties: { orgId: { type: 'string' } }, required: ['orgId'] },
      },
      [],
      new Set(['orgId']),
    );
    expect(argBindings[0].via).toBe('context');
    expect(argBindings[0].contextKey).toBe('orgId');
  });

  it('refuses to fan out over two discovery args (no cross-product)', () => {
    const discovery = [kind('sites', 'cloud_id'), kind('channels', 'channel_id')];
    const { argBindings, parentKind } = resolveArgBindings(
      {
        kind: 't',
        tool: 'list_t',
        input: {
          type: 'object',
          properties: { cloudId: { type: 'string' }, channelId: { type: 'string' } },
          required: ['cloudId', 'channelId'],
        },
      },
      discovery,
    );
    expect(parentKind).toBeUndefined();
    expect(argBindings.every((b) => b.via === 'unresolved')).toBe(true);
    expect(argBindings[0].reason).toMatch(/multi-parent/);
  });
});
