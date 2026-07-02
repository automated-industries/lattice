// Auto-composed segment of the GUI client script (see modules/index.ts). Collapse
// or expand the three layout columns — Inputs, Model, Outputs — to thin rails. Each
// column header carries a `.col-collapse` button; the state persists in
// localStorage and the layout grid is recomputed so at least one column always
// keeps a flexible track. Called from boot() (initColumnCollapse), so it must stay
// INSIDE the main client IIFE.
export const columnCollapseJs = `
    function colCollapseKey(col) { return 'lattice.col.collapsed.' + col; }
    function colCollapsed(col) {
      try { return window.localStorage.getItem(colCollapseKey(col)) === '1'; } catch (e) { return false; }
    }
    function setColCollapsed(col, on) {
      try { window.localStorage.setItem(colCollapseKey(col), on ? '1' : '0'); } catch (e) { /* private mode */ }
    }
    function applyColumnCollapse() {
      var inC = colCollapsed('inputs'), moC = colCollapsed('model'), ouC = colCollapsed('outputs');
      // The grid tracks (incl. keeping a flexible column) are driven by these body
      // classes in pure CSS — see .layout in the stylesheet.
      document.body.classList.toggle('collapse-inputs', inC);
      document.body.classList.toggle('collapse-model', moC);
      document.body.classList.toggle('collapse-outputs', ouC);
      document.querySelectorAll('.col-collapse[data-col]').forEach(function (b) {
        var col = b.getAttribute('data-col');
        var on = col === 'inputs' ? inC : (col === 'outputs' ? ouC : moC);
        b.setAttribute('aria-expanded', on ? 'false' : 'true');
        b.setAttribute('title', (on ? 'Expand ' : 'Collapse ') + col.charAt(0).toUpperCase() + col.slice(1));
      });
    }
    function initColumnCollapse() {
      document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('.col-collapse[data-col]') : null;
        if (!btn) return;
        setColCollapsed(btn.getAttribute('data-col'), !colCollapsed(btn.getAttribute('data-col')));
        applyColumnCollapse();
      });
      applyColumnCollapse();
    }
`;
