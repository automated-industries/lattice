// An authored HTML artifact renders in a deliberately strict sandbox: an iframe with
// `sandbox="allow-scripts"` (no allow-same-origin, no allow-modals, no allow-popups,
// no allow-top-navigation) under a no-network CSP. That isolation is intentional and
// must stay — but it silently disables whole classes of interactive elements a model
// tends to author anyway: a "Print / PDF" button (`print()` needs allow-modals), a
// "pop out" link (`window.open` / `target="_blank"` needs allow-popups), an
// `alert()`/`confirm()`/`prompt()` dialog, a form POST (network + form-action are
// blocked). Those elements render but do nothing on click — a dead button with no
// error, which reads as broken.
//
// Rather than loosen the sandbox, we STRIP the elements that can only fail inside it
// and report what was removed, so the caller can tell the user in chat. Keep the
// sandbox strict; keep the artifact honest.
import { JSDOM } from 'jsdom';

export interface ArtifactSanitizeResult {
  /** The cleaned HTML (blocked elements removed / blocked attributes neutralized). */
  html: string;
  /** Human-readable descriptors of what was removed, for a chat notice. Empty ⇒ no change. */
  removed: string[];
}

// A sandbox-blocked capability invoked as a GLOBAL. Two shapes: (1) window/self/globalThis
// .<method>( for the window-object methods — these names collide with same-named, perfectly
// valid in-page methods (element.open, canvas ctx.moveTo, indexedDB.open) that work under
// allow-scripts, so we only flag them on an explicit window receiver; (2) a BARE dialog /
// print global not written as a member access (`print(`, `alert(`, …) — a `.print(` on some
// object is not window.print and must not match.
const BLOCKED_CALL =
  /\b(?:window|self|globalThis)\s*\.\s*(?:print|open|alert|confirm|prompt|showModalDialog|moveTo|moveBy|resizeTo|resizeBy)\s*\(|(?<![\w$.])(?:print|alert|confirm|prompt|showModalDialog)\s*\(/;
// Reaching out of the frame (also blocked: no allow-top-navigation / opaque origin).
const TOP_NAV = /\b(?:top|parent)\b\s*\.\s*(?:location|open)\b/;

const HANDLER_ATTRS = [
  'onclick',
  'onmousedown',
  'onmouseup',
  'ondblclick',
  'onsubmit',
  'onkeydown',
  'onkeyup',
  'ontouchstart',
  'onpointerdown',
];

function describe(tag: string, label: string, why: string): string {
  const name = label ? `"${label.replace(/\s+/g, ' ').trim().slice(0, 40)}"` : `a <${tag}>`;
  return `${name} — ${why}`;
}

// A control whose whole purpose is a click action (safe to delete entirely) vs. a
// container that wraps real content (only its dead handler should be stripped). Buttons /
// links / inputs / areas are controls; so is any element with no child elements.
function isLeafControl(tag: string, el: Element): boolean {
  return /^(?:button|a|area|input)$/.test(tag) || el.children.length === 0;
}

/**
 * Remove / neutralize the elements of an authored HTML artifact that can only fail
 * inside the strict artifact sandbox, and report what changed. Returns the input
 * unchanged (and `removed: []`) when there is nothing to strip, so a clean artifact is
 * byte-identical.
 */
export function sanitizeSandboxedHtml(rawHtml: string): ArtifactSanitizeResult {
  const removed: string[] = [];
  if (!rawHtml.includes('<')) return { html: rawHtml, removed };

  const dom = new JSDOM('<!doctype html><body>' + rawHtml + '</body>');
  const doc = dom.window.document;

  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    // First non-empty of text / value / title for a human label (empty strings fall
    // through, so nullish coalescing is not what we want here).
    const text = el.textContent ?? '';
    const val = el.getAttribute('value') ?? '';
    const title = el.getAttribute('title') ?? '';
    const label = text || val || title;

    // 1) An inline event handler whose body invokes a blocked capability. The element's
    //    whole purpose is that dead action, so remove it.
    let handlerHit = '';
    for (const attr of HANDLER_ATTRS) {
      const v = el.getAttribute(attr);
      if (v && (BLOCKED_CALL.test(v) || TOP_NAV.test(v))) {
        handlerHit = attr;
        break;
      }
    }
    if (handlerHit) {
      if (isLeafControl(tag, el)) {
        // A control whose whole purpose is the dead action — remove it.
        removed.push(
          describe(
            tag,
            label,
            "it triggers a browser action (print, pop-out, or dialog) that can't run in the secure preview",
          ),
        );
        el.remove();
      } else {
        // A container that merely carries a blocked inline handler wraps real content —
        // neutralize only the handler and keep the children (mirrors the neutralize-not-
        // delete approach used for target=_blank / form action below).
        el.removeAttribute(handlerHit);
        removed.push(
          describe(tag, label, "a click action that can't run in the secure preview was disabled"),
        );
      }
      continue;
    }

    // 2) A javascript: link that invokes a blocked capability — same story.
    const href = el.getAttribute('href');
    if (href && /^\s*javascript:/i.test(href) && (BLOCKED_CALL.test(href) || TOP_NAV.test(href))) {
      if (isLeafControl(tag, el)) {
        removed.push(
          describe(
            tag,
            label,
            "its link runs a browser action that can't run in the secure preview",
          ),
        );
        el.remove();
      } else {
        el.removeAttribute('href');
        removed.push(
          describe(tag, label, "a link action that can't run in the secure preview was disabled"),
        );
      }
      continue;
    }

    // 3) A pop-out target on a link/area/form/base: the sandbox has no allow-popups, so
    //    the click would silently do nothing. Neutralize the attribute (keep the
    //    element + its text) rather than delete legitimate content.
    if ((el.getAttribute('target') ?? '').toLowerCase() === '_blank') {
      el.removeAttribute('target');
      removed.push(
        describe(
          tag,
          label,
          'its "open in a new window" behaviour was disabled (pop-outs are blocked in the preview)',
        ),
      );
    }

    // 4) A form that submits somewhere: the CSP blocks all network + form-action, so the
    //    submit is dead. Neutralize the action/method so the button can't look live.
    if (tag === 'form' && (el.hasAttribute('action') || el.hasAttribute('method'))) {
      el.removeAttribute('action');
      el.removeAttribute('method');
      removed.push(
        describe(tag, label, 'its submit target was removed (the preview has no network access)'),
      );
    }
  }

  if (!removed.length) return { html: rawHtml, removed };
  return { html: doc.body.innerHTML, removed };
}
