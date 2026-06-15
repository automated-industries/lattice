// Google Analytics 4 (gtag.js) for the GUI — opt-in, gated on the existing
// "Send anonymous analytics" preference. Inlined into the served HTML as an IIFE
// that defines `window.LatticeGA` (mirrors the css / appJs string pattern). It
// makes NO network contact while opted out: gtag.js is injected lazily by
// `load()`, which only runs once consent is true (and Do-Not-Track is off).
//
// Privacy contract (hard rules — enforced by sanitize() + the synthetic
// pageView): we NEVER send table/column/db/workspace names, row ids or content,
// file names, search/chat text, display name, email, file paths, or the
// localhost port. Only coarse enum/boolean/number event params, and a synthetic
// route-type page_location.
export const analyticsJs = `
(function () {
  var MEASUREMENT_ID = 'G-3M1RPJ4ZB3';
  var DISABLE_FLAG = 'ga-disable-' + MEASUREMENT_ID;
  var loaded = false;
  var consent = false;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }

  function doNotTrack() {
    var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
    return dnt === '1' || dnt === 'yes' || dnt === true;
  }

  // Inject gtag.js exactly once, and only when called (i.e. only with consent).
  function load() {
    if (loaded) return;
    loaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
    document.head.appendChild(s);
    gtag('js', new Date());
    gtag('config', MEASUREMENT_ID, {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      anonymize_ip: true,
    });
  }

  // Allow only a small, safe set of value types. Strings must be short enum-like
  // tokens; anything free-form (a table name, email, path, query, row content)
  // is DROPPED, not sent.
  function sanitize(params) {
    var out = {};
    if (!params || typeof params !== 'object') return out;
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'number' && isFinite(v)) out[k] = v;
      else if (typeof v === 'string' && /^[a-z0-9_.-]{1,40}$/.test(v)) out[k] = v;
    });
    return out;
  }

  window.LatticeGA = {
    MEASUREMENT_ID: MEASUREMENT_ID,
    // Called once at boot with the resolved consent. Loads gtag.js only if
    // consented (and DNT off); otherwise no network contact happens at all.
    init: function (enabled) {
      consent = !!enabled;
      window[DISABLE_FLAG] = !consent;
      if (consent && !doNotTrack()) load();
    },
    // Toggle consent at runtime (the preferences checkbox). Turning it on lazily
    // loads gtag.js; turning it off sets GA's own kill switch.
    setConsent: function (enabled) {
      consent = !!enabled;
      window[DISABLE_FLAG] = !consent;
      if (consent && !doNotTrack()) load();
    },
    track: function (name, params) {
      if (!consent || !loaded) return;
      if (typeof name !== 'string' || !/^[a-z0-9_]{1,40}$/.test(name)) return;
      gtag('event', name, sanitize(params));
    },
    // A synthetic, non-identifying page_view: only the coarse route TYPE, never
    // the real hash (which embeds table names / row ids / db names).
    pageView: function (routeType) {
      if (!consent || !loaded) return;
      var t =
        typeof routeType === 'string' && /^[a-z0-9_-]{1,40}$/.test(routeType) ? routeType : 'unknown';
      gtag('event', 'page_view', {
        page_location: 'https://app.lattice.local/' + t,
        page_title: t,
      });
    },
  };
})();
`;
