// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const latticeTeamsJs = `    // ────────────────────────────────────────────────────────────
    // Outputs column resize — drag the left edge, clamp, persist.
    // ────────────────────────────────────────────────────────────
    var OUT_MIN = 320, OUT_MAX = 640, OUT_KEY = 'lattice-outputs-width';
    function applyOutputsWidth(px) {
      var w = Math.min(OUT_MAX, Math.max(OUT_MIN, Math.round(px)));
      document.documentElement.style.setProperty('--outputs-width', w + 'px');
      return w;
    }
    function initOutputsResize() {
      var saved = parseInt(window.localStorage.getItem(OUT_KEY) || '', 10);
      if (!isNaN(saved)) applyOutputsWidth(saved);
      var handle = document.getElementById('outputs-resize');
      if (!handle) return;
      handle.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        var startX = e.clientX;
        var col = document.getElementById('outputs-rail');
        var startW = col ? col.getBoundingClientRect().width : 416;
        handle.classList.add('dragging');
        function move(ev) {
          // The Outputs column sits on the right; dragging left (smaller clientX) widens it.
          applyOutputsWidth(startW - (ev.clientX - startX));
        }
        function up() {
          handle.classList.remove('dragging');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          var cur = parseInt(
            getComputedStyle(document.documentElement).getPropertyValue('--outputs-width'),
            10,
          );
          if (!isNaN(cur)) window.localStorage.setItem(OUT_KEY, String(cur));
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }

`;
