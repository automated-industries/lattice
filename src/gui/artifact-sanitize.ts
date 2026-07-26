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

    // 5) Styled-as-interactive inert elements: detect `cursor: help` or `cursor: pointer`
    //    on elements that have no `title`, `href`, or event handlers. These create a fake
    //    affordance (cursor changes to suggest interactivity) but nothing happens on click —
    //    a usability trap. Neutralize the cursor affordance (remove it from inline styles,
    //    or override it) while keeping the element + its text intact. Safe because:
    //    - Elements WITH title/href/handler legitimately use these cursors — we skip them.
    //    - Only affects presentation (cursor style), never content or structure.
    const inlineStyle = el.getAttribute('style') ?? '';
    const hasCursorAffordance = /cursor\s*:\s*(?:help|pointer)/i.test(inlineStyle);

    if (hasCursorAffordance) {
      const href = el.getAttribute('href');
      const titleAttr = el.getAttribute('title');
      const hasHandler = HANDLER_ATTRS.some((attr) => el.hasAttribute(attr));

      if (!href && !titleAttr && !hasHandler) {
        // Element is styled as interactive but isn't — neutralize the cursor affordance.
        // Remove the cursor declaration from the inline style.
        const newStyle = inlineStyle
          .split(';')
          .filter((decl) => !/cursor\s*:/i.test(decl))
          .join(';')
          .trim();

        if (newStyle) {
          el.setAttribute('style', newStyle);
        } else {
          el.removeAttribute('style');
        }

        removed.push(
          describe(
            tag,
            label,
            'its interactive-style cursor affordance was removed — it has no title attribute, link, or event handler, so it cannot actually be interactive',
          ),
        );
      }
    }
  }

  // Final pass: scan <style> blocks for class-based cursor rules (e.g. .source-tag { cursor: help; })
  // and neutralize the cursor affordance on matching elements that lack title/href/handlers.
  // This is a targeted pass for the common case of utility classes styling multiple elements.
  const styleElements = Array.from(doc.querySelectorAll('style'));
  for (const styleEl of styleElements) {
    const css = styleEl.textContent ?? '';
    if (!/cursor\s*:\s*(?:help|pointer)/i.test(css)) continue;

    // Simple pattern: match class-based rules like ".classname { ... cursor: help ... }"
    // Captures the class name without complex CSS selector parsing.
    const classPattern = /\.([a-z_-][a-z0-9_-]*)\s*\{[^}]*cursor\s*:\s*(?:help|pointer)[^}]*\}/gi;
    let match: RegExpExecArray | null;

    while ((match = classPattern.exec(css)) !== null) {
      const className = match[1];
      if (!className) continue;
      const selector = `.${className}`;

      // Try to find elements with this class (skip on selector error).
      try {
        const matching = doc.querySelectorAll(selector);
        for (const el of matching) {
          const href = el.getAttribute('href');
          const titleAttr = el.getAttribute('title');
          const hasHandler = HANDLER_ATTRS.some((attr) => el.hasAttribute(attr));

          if (!href && !titleAttr && !hasHandler) {
            // This element has the cursor affordance class but isn't interactive.
            // Override the cursor style via inline style (more reliable than trying to edit the CSS).
            const current = el.getAttribute('style') ?? '';
            const override = current ? `${current}; cursor: default;` : 'cursor: default;';
            el.setAttribute('style', override);

            const elTag = el.tagName.toLowerCase();
            const elText = el.textContent ?? '';
            const elVal = el.getAttribute('value') ?? '';
            const elTitle = el.getAttribute('title') ?? '';
            const elLabel = elText || elVal || elTitle;

            removed.push(
              describe(
                elTag,
                elLabel,
                'its interactive-style cursor affordance (from a class rule) was overridden — it has no title attribute, link, or event handler',
              ),
            );
          }
        }
      } catch {
        // Invalid selector or other error — skip this rule.
      }
    }
  }

  if (!removed.length) return { html: rawHtml, removed };
  return { html: doc.body.innerHTML, removed };
}
