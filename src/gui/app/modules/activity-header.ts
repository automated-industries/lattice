// Auto-composed segment of the GUI client script (see modules/index.ts). The live
// activity feed lives in the HEADER (next to the version-history clock) as a small
// popover: each data change the app sees gets logged here. renderFeedItem (in the
// data-model segment) appends cards via activityFeedEl()/bumpActivityCount(). Must
// stay INSIDE the client IIFE; inserted before createDatabaseWizardJs.
export const activityHeaderJs = `
    function activityFeedEl() { return document.getElementById('activity-feed'); }

    var activityUnseen = 0;
    function activityPopoverOpen() {
      var pop = document.getElementById('activity-popover');
      return !!pop && !pop.hidden;
    }
    function bumpActivityCount() {
      // While the popover is open the user is watching live — don't accrue a badge.
      if (activityPopoverOpen()) return;
      activityUnseen++;
      var c = document.getElementById('activity-count');
      if (c) { c.textContent = activityUnseen > 99 ? '99+' : String(activityUnseen); c.hidden = false; }
    }
    function clearActivityCount() {
      activityUnseen = 0;
      var c = document.getElementById('activity-count');
      if (c) { c.hidden = true; c.textContent = '0'; }
    }

    function initActivityHeader() {
      var pill = document.getElementById('activity-pill');
      var pop = document.getElementById('activity-popover');
      if (!pill || !pop || pill.__wired) return;
      pill.__wired = true;
      pill.addEventListener('click', function (e) {
        e.stopPropagation();
        var willOpen = pop.hidden;
        pop.hidden = !willOpen;
        pill.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) clearActivityCount();
      });
      // Click-away closes the popover (but not clicks inside it or on the pill).
      document.addEventListener('click', function (e) {
        if (pop.hidden) return;
        if (pop.contains(e.target) || pill.contains(e.target)) return;
        pop.hidden = true;
        pill.setAttribute('aria-expanded', 'false');
      });
    }
`;
