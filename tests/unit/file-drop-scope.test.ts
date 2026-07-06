// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { askLatticeJs } from '../../src/gui/app/modules/ask-lattice.js';

/**
 * File drag-drop target by view:
 *   • Analytics — the Gladys chat dock (#ask-dock) is on screen, so the drop zone is
 *     JUST that chat window: a file dropped ONTO it is STAGED into the composer; a
 *     drop elsewhere (over the dashboards) is ignored.
 *   • Configure — no chat here, so the whole window is the drop zone and a drop
 *     INGESTS immediately.
 *
 * These execute the real initFileDropZone() in jsdom (deps stubbed, #ask-dock's
 * layout rect mocked since jsdom does no layout) and dispatch drops at coordinates
 * inside vs outside the chat window.
 */

const RECT = {
  left: 800,
  right: 1100,
  top: 100,
  bottom: 700,
  width: 300,
  height: 600,
  x: 800,
  y: 100,
};

interface G extends Record<string, unknown> {
  isAnalyticsHash: (h: string) => boolean;
  stageFiles: ReturnType<typeof vi.fn>;
  uploadFiles: ReturnType<typeof vi.fn>;
  initAnalyticsView: () => void;
  initFileDropZone: () => void;
}
const w = globalThis as unknown as G;
let analytics = true;

beforeEach(() => {
  analytics = true;
  w.isAnalyticsHash = () => analytics;
  w.stageFiles = vi.fn();
  w.uploadFiles = vi.fn();
  w.initAnalyticsView = () => undefined;
  document.body.innerHTML = '<aside id="ask-dock"></aside>';
  const dock = document.getElementById('ask-dock');
  if (dock) dock.getBoundingClientRect = () => RECT as DOMRect;
  // Indirect eval defines initFileDropZone on the global; the internal
  // __fileDropWired guard makes the wiring idempotent across tests (one listener set).
  (0, eval)(askLatticeJs as string);
  w.initFileDropZone();
});

function drop(x: number, y: number): void {
  const ev = new Event('drop', { bubbles: true, cancelable: true }) as Event & {
    dataTransfer: unknown;
    clientX: number;
    clientY: number;
  };
  ev.dataTransfer = { types: ['Files'], files: [{ name: 'a.pdf' }] };
  ev.clientX = x;
  ev.clientY = y;
  document.dispatchEvent(ev);
}

describe('file drag-drop is scoped to the chat window in Analytics', () => {
  it('Analytics: a file dropped ONTO the chat window is staged (not ingested)', () => {
    analytics = true;
    drop(900, 400); // inside #ask-dock
    expect(w.stageFiles).toHaveBeenCalledTimes(1);
    expect(w.uploadFiles).not.toHaveBeenCalled();
  });

  it('Analytics: a file dropped OUTSIDE the chat window (dashboards) is ignored', () => {
    analytics = true;
    drop(100, 400); // left of #ask-dock
    expect(w.stageFiles).not.toHaveBeenCalled();
    expect(w.uploadFiles).not.toHaveBeenCalled();
  });

  it('Configure: a file dropped anywhere ingests immediately (whole-window zone)', () => {
    analytics = false;
    drop(100, 400); // anywhere
    expect(w.uploadFiles).toHaveBeenCalledTimes(1);
    expect(w.stageFiles).not.toHaveBeenCalled();
  });
});
