// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const latticeTeamsJs = `    // ────────────────────────────────────────────────────────────
    // Assistant rail resize — drag the left edge, clamp, persist.
    // ────────────────────────────────────────────────────────────
    var RAIL_MIN = 320, RAIL_MAX = 640, RAIL_KEY = 'lattice-rail-width';
    function applyRailWidth(px) {
      var w = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
      document.documentElement.style.setProperty('--sidebar-width', w + 'px');
      return w;
    }
    function initRailResize() {
      var saved = parseInt(window.localStorage.getItem(RAIL_KEY) || '', 10);
      if (!isNaN(saved)) applyRailWidth(saved);
      var handle = document.getElementById('rail-resize');
      if (!handle) return;
      handle.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        var startX = e.clientX;
        var rail = document.getElementById('assistant-rail');
        var startW = rail ? rail.getBoundingClientRect().width : 380;
        handle.classList.add('dragging');
        function move(ev) {
          // Rail sits on the right; dragging left (smaller clientX) widens it.
          applyRailWidth(startW - (ev.clientX - startX));
        }
        function up() {
          handle.classList.remove('dragging');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          var cur = parseInt(
            getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'),
            10,
          );
          if (!isNaN(cur)) window.localStorage.setItem(RAIL_KEY, String(cur));
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }

`;
