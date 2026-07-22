/**
 * The curated flagship catalog — the authoritative prefab entries for the best-known services.
 *
 * ⚠️ SPIKE-VERIFY each endpoint + scope against a LIVE server before shipping one-click connect.
 * The URLs below are the vendors' documented remote MCP endpoints (public information). Only
 * Atlassian is true one-click (OAuth 2.1 + Dynamic Client Registration); the others need a
 * pre-registered OAuth client (the connect form reveals client-id/secret fields for them). Icons
 * are self-authored monograms — no third-party logo bytes are committed.
 */

import { letterIcon } from '../mcp/icon.js';
import type { CatalogEntry } from './types.js';

export function curatedCatalog(): CatalogEntry[] {
  return [
    {
      id: 'atlassian',
      label: 'Jira & Confluence',
      icon: letterIcon('A', '#0052cc'),
      serverUrl: 'https://mcp.atlassian.com/v1/mcp/authv2',
      transport: 'http',
      scope:
        'read:jira-work read:jira-user read:confluence-space.summary read:confluence-content.summary offline_access',
      oneClick: true,
      helpUrl:
        'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
      source: 'curated',
    },
    {
      id: 'gmail',
      label: 'Gmail',
      icon: letterIcon('M', '#ea4335'),
      serverUrl: 'https://gmailmcp.googleapis.com/mcp/v1',
      transport: 'http',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      needsClientCreds: true,
      authHint: 'Google Workspace — developer preview',
      helpUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
      source: 'curated',
    },
    {
      id: 'gcal',
      label: 'Google Calendar',
      icon: letterIcon('C', '#4285f4'),
      serverUrl: 'https://calendarmcp.googleapis.com/mcp/v1',
      transport: 'http',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      needsClientCreds: true,
      authHint: 'Google Workspace — developer preview',
      helpUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
      source: 'curated',
    },
    {
      id: 'gdrive',
      label: 'Google Drive',
      icon: letterIcon('D', '#0f9d58'),
      serverUrl: 'https://drivemcp.googleapis.com/mcp/v1',
      transport: 'http',
      scope: 'https://www.googleapis.com/auth/drive.metadata.readonly',
      needsClientCreds: true,
      authHint: 'Google Workspace — developer preview',
      helpUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
      source: 'curated',
    },
    {
      id: 'slack',
      label: 'Slack',
      icon: letterIcon('S', '#4a154b'),
      serverUrl: 'https://mcp.slack.com/mcp',
      transport: 'http',
      scope: 'channels:read groups:read users:read channels:history',
      needsClientCreds: true,
      authHint: 'Requires a Slack app (user token)',
      helpUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
      source: 'curated',
    },
    {
      id: 'salesforce',
      label: 'Salesforce',
      icon: letterIcon('S', '#00a1e0'),
      serverUrl: 'https://api.salesforce.com/platform/mcp/v1/',
      transport: 'http',
      scope: 'mcp_api refresh_token',
      needsClientCreds: true,
      authHint: 'Enterprise Edition or above',
      helpUrl: 'https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/',
      source: 'curated',
    },
  ];
}
