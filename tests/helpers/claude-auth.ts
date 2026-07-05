import {
  setAssistantCredential,
  deleteAssistantCredential,
} from '../../src/framework/user-config.js';

// The machine-local credential kind a connected Claude subscription is stored
// under (mirrors CLAUDE_OAUTH_KIND in src/gui/assistant-routes.ts). Claude access
// is OAuth-only now, so tests that need the assistant authenticated seed a fake
// subscription token here instead of setting an API key.
const CLAUDE_OAUTH_KIND = 'claude_oauth';

/**
 * Seed a connected Claude subscription for a test. Requires `LATTICE_CONFIG_DIR`
 * to already point at the test's isolated config dir (the store is machine-local,
 * keyed off that dir). The token never reaches a real endpoint — tests either
 * assert the pre-flight gate/handler behavior or point the SDK at a dead URL.
 */
export function seedClaudeOAuth(accessToken = 'oauth-test-token'): void {
  setAssistantCredential(CLAUDE_OAUTH_KIND, JSON.stringify({ access_token: accessToken }));
}

/** Remove the seeded subscription (return to the disconnected state). */
export function clearClaudeOAuth(): void {
  deleteAssistantCredential(CLAUDE_OAUTH_KIND);
}
