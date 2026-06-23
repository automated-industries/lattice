// System-browser bridge for the desktop webview.
//
// The embedded webview is a single window with no tabs or popups, so the GUI's
// `<a target="_blank">` links and `window.open()` calls are silent no-ops. This
// bridge (1) exposes an `openExternal` host binding that launches the OS default
// browser, and (2) injects a page script that routes external-link clicks to it.
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
 * for EXTERNAL origins to the `openExternal` host binding (system browser).
 * Same-origin `_blank` links navigate in place. The OAuth start link is fetched
 * as JSON first so the verifier cookie stays on the webview.
 */
export const LINK_INTERCEPTOR_JS = `(() => {
  if (window.__latticeDesktopLinkBridge) return;
  window.__latticeDesktopLinkBridge = true;
  const isExternal = (u) => { try { return new URL(u, location.href).origin !== location.origin; } catch { return false; } };
  const ext = (u) => { try { bindings.openExternal(new URL(u, location.href).href); } catch (e) { console.error('openExternal', e); } };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    const abs = new URL(href, location.href);
    e.preventDefault();
    if (abs.pathname === '/api/assistant/oauth/start') {
      // Keep the PKCE verifier cookie on the webview; open only the provider URL externally.
      fetch(abs.href, { headers: { Accept: 'application/json' } })
        .then((r) => r.json())
        .then((d) => { if (d && d.authorizeUrl) ext(d.authorizeUrl); })
        .catch(() => ext(abs.href));
    } else if (abs.origin !== location.origin) {
      ext(abs.href);
    } else {
      location.href = abs.href; // same-origin _blank → navigate in place
    }
  }, true);
  const _open = window.open;
  window.open = function (u) {
    if (u && isExternal(u)) { ext(u); return null; }
    return _open ? _open.apply(window, arguments) : null;
  };
})();`;
