/**
 * The Trello connector's logo, as a self-contained `data:` URI consumed by
 * {@link TrelloConnector.presentation}. A small inline brand-colored SVG (a
 * two-column board on a blue tile) — no binary asset, no static-asset route, no
 * extra dependency. The GUI only ever sets this as an `<img src>`, never as HTML.
 */

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">' +
  '<rect width="48" height="48" rx="8" fill="#0079BF"/>' +
  '<rect x="9" y="9" width="12" height="30" rx="2" fill="#fff"/>' +
  '<rect x="27" y="9" width="12" height="18" rx="2" fill="#fff"/>' +
  '</svg>';

/** Trello logo as a base64-encoded SVG `data:` URI. */
export const TRELLO_ICON = `data:image/svg+xml;base64,${Buffer.from(SVG, 'utf8').toString('base64')}`;
