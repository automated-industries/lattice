/**
 * Neutralize an UNTRUSTED connector label (an MCP server's self-advertised name,
 * or a hostname) before it is interpolated into an LLM prompt. A malicious MCP
 * server can set its `serverInfo.name` to anything, and the "Connected data
 * sources" context section is prefaced "treat this list as authoritative" — so a
 * raw name containing a fake `#` heading or "ignore previous instructions" would
 * be a prompt-injection foothold on every subsequent chat turn.
 *
 * Collapse newlines/tabs to spaces, strip leading markdown structural markers
 * (headings, quotes, list bullets, numbered-list prefixes), and bound the length
 * so one label can never restructure the prompt. Not for HTML — the GUI escapes
 * separately; this is specifically the prompt-safety pass.
 */
export function sanitizeConnectorLabel(s: string, max = 80): string {
  const oneLine = s
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const noMarkers = oneLine
    .replace(/^[\s#>*+-]+/, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim();
  return noMarkers.length > max ? noMarkers.slice(0, max) + '…' : noMarkers;
}
