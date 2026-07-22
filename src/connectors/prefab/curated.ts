/**
 * The curated flagship catalog — the authoritative prefab entries for the best-known services.
 *
 * Endpoints + scopes verified against each vendor's LIVE OAuth metadata (unauthenticated probe of
 * the server's `.well-known/oauth-protected-resource`) and public docs. Every URL responds as a
 * real MCP server; the scopes below are drawn from each server's advertised `scopes_supported`.
 * Only Atlassian is true one-click (OAuth 2.1 + Dynamic Client Registration); the others need a
 * pre-registered OAuth client (the connect form reveals client-id/secret fields for them). A final
 * authorized end-to-end smoke (sign in with a real account, confirm tables populate) still wants a
 * human — the generic engine derives the table schema at connect, so there are no hand-mappers to
 * verify. Icons are self-authored monograms — no third-party logo bytes are committed.
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
      // Scopes confirmed against the live protected-resource metadata's scopes_supported
      // (auth.atlassian.com); the older read:confluence-*.summary / read:jira-user names are not
      // advertised by this server.
      scope:
        'read:jira-work search:confluence read:confluence-user read:space:confluence read:page:confluence offline_access',
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
      scope: 'https://www.googleapis.com/auth/calendar.events.readonly',
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
      scope: 'https://www.googleapis.com/auth/drive.readonly',
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
      // The server advertises `api`/`sfap_api`/`refresh_token` (live protected-resource metadata);
      // `mcp_api` is not a valid Salesforce scope.
      scope: 'api refresh_token',
      needsClientCreds: true,
      authHint: 'Enterprise Edition or above',
      helpUrl: 'https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/',
      source: 'curated',
    },
  ];
}
