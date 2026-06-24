// System-browser bridge for the desktop webview.
//
// The embedded webview is a single window with no tabs or popups, so the GUI's
// `<a target="_blank">` links and `window.open()` calls are silent no-ops. This
// bridge routes external-link clicks to the OS default browser. It uses a
// same-origin `fetch` to the GUI server's `/api/desktop/open` route (the host
// passes a `desktopOpenExternal` opener into `startGuiServer`) rather than the
// webview's host bindings, which proved unreliable in the desktop canary.
//
// The OAuth "Connect with Claude" link is special-cased: its PKCE verifier cookie
// must stay on the webview (that's where the pasted code is exchanged), so the
// script fetches the authorize URL via the JSON variant of /oauth/start (keeping
// the cookie local) and opens ONLY the provider URL in the system browser.

/** Open a URL in the operating system's default browser. */
export function openInSystemBrowser(url: string): void {
  const os = Deno.build.os;
  const [cmd, args] =
    os === 'darwin'
      ? ['open', [url]]
      : os === 'windows'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    new Deno.Command(cmd as string, {
      args: args as string[],
      stdout: 'null',
      stderr: 'null',
    }).spawn();
  } catch (err) {
    console.error('[desktop] openInSystemBrowser failed:', (err as Error).message);
  }
}

/**
 * Idempotent page script: routes `target="_blank"` clicks and `window.open()`
 * for EXTERNAL origins to the system browser via `GET /api/desktop/open`.
 * Same-origin `_blank` links navigate in place. The OAuth start link is fetched
 * as JSON first so the verifier cookie stays on the webview. The idempotency
 * guard is per-document, so a re-inject after a page reload re-installs it.
 */
export const LINK_INTERCEPTOR_JS = `(() => {
  if (window.__latticeDesktopLinkBridge) return;
  window.__latticeDesktopLinkBridge = true;
  const open = (u) => { try { fetch('/api/desktop/open?url=' + encodeURIComponent(u)); } catch (e) {} };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
    if (!a) return;
    const abs = new URL(a.getAttribute('href') || '', location.href);
    e.preventDefault();
    if (abs.pathname === '/api/assistant/oauth/start') {
      // Keep the PKCE verifier cookie on the webview; open only the provider URL externally.
      fetch(abs.href, { headers: { Accept: 'application/json' } })
        .then((r) => r.json())
        .then((d) => { if (d && d.authorizeUrl) open(d.authorizeUrl); })
        .catch(() => {});
    } else if (abs.origin !== location.origin) {
      open(abs.href);
    } else {
      location.href = abs.href; // same-origin _blank → navigate in place
    }
  }, true);
  const _open = window.open;
  window.open = function (u) {
    if (u) {
      try { const abs = new URL(u, location.href); if (abs.origin !== location.origin) { open(abs.href); return null; } } catch (e) {}
    }
    return _open ? _open.apply(window, arguments) : null;
  };
})();`;
