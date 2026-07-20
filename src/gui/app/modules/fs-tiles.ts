// Auto-composed segment of the GUI client script (see modules/index.ts). The
// shared tile renderer: one object/file "card" for a grid. Extracted from the
// old Objects view so it can be reused by the Configure → Inputs → Files grid
// toggle AND the record page's "Connected objects" grid. Depends only on
// escapeHtml. Must stay INSIDE the client IIFE (registered before
// createDatabaseWizardJs in modules/index.ts). Function declarations hoist across
// the concatenated body, so any segment can call fsTileHtml regardless of order.
export const fsTilesJs = `
    // An object or file tile for a .fs-grid. Also an mt-card + data-table so the
    // global wire/merge drag handler can treat it as a wireable object.
    // Double-click / Enter opens (data-href). A FOLDER's name is click-to-rename
    // inline (data-rename); a FILE/object uses its own emoji + name as the label.
    function fsTileHtml(href, icon, label, table, meta, kind) {
      var isFolder = kind === 'folder';
      var labelHtml = isFolder
        ? '<span class="fs-tile-name" data-rename="' + escapeHtml(table) + '">' + escapeHtml(label) + '</span>'
        : escapeHtml(label);
      return '<div class="fs-tile fs-' + kind + ' mt-card" role="link" tabindex="0" ' +
        'data-href="' + escapeHtml(href) + '" data-table="' + escapeHtml(table) + '" data-kind="' + kind + '" ' +
        'title="' + escapeHtml(label) + '">' +
        '<div class="fs-tile-icon">' + icon + '</div>' +
        '<div class="fs-tile-label">' + labelHtml + '</div>' +
        (meta ? '<div class="fs-folder-count">' + escapeHtml(String(meta)) + '</div>' : '') +
        '</div>';
    }
`;
