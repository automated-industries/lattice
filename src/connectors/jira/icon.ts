/**
 * The Jira connector's logo, as a self-contained `data:` URI consumed by
 * {@link JiraConnector.presentation}. A small inline brand-colored SVG (stacked
 * chevrons on a blue tile) — no binary asset, no static-asset route, no extra
 * dependency. The GUI only ever sets this as an `<img src>`, never as HTML.
 */

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">' +
  '<rect width="48" height="48" rx="8" fill="#0052CC"/>' +
  '<path d="M24 9l11 11-11 11-3-3 8-8-8-8z" fill="#fff" opacity="0.55"/>' +
  '<path d="M24 18l11 11-11 11-3-3 8-8-8-8z" fill="#fff"/>' +
  '</svg>';

/** Jira logo as a base64-encoded SVG `data:` URI. */
export const JIRA_ICON = `data:image/svg+xml;base64,${Buffer.from(SVG, 'utf8').toString('base64')}`;
