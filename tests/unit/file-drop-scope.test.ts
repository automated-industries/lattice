// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { askLatticeJs } from '../../src/gui/app/modules/ask-lattice.js';

/**
 * File drag-drop is scoped to ONE surface per view — there is no whole-window drop:
 *   • Analytics — the Gladys chat dock (#ask-dock): a file dropped ONTO it is STAGED
 *     into the composer; a drop elsewhere (over the dashboards) is ignored.
 *   • Configure — the Inputs column (nav.sidebar) ONLY: a file dropped onto it INGESTS
 *     immediately; a drop anywhere else in Configure (Model / Outputs) is ignored.
 * A dropped FOLDER is expanded into its constituent files via the Entries API before
 * staging/uploading (a bare folder entry has no bytes and would fail to ingest).
 *
 * These run the real initFileDropZone() in jsdom (deps stubbed, rects mocked since jsdom
 * does no layout). The drop handler resolves files asynchronously (folder expansion), so
 * each assertion awaits a microtask/macrotask flush.
 */

const DOCK_RECT = {
  left: 800,
  right: 1100,
  top: 100,
  bottom: 700,
  width: 300,
  height: 600,
  x: 800,
  y: 100,
};
const SIDEBAR_RECT = {
  left: 0,
  right: 240,
  top: 60,
  bottom: 900,
  width: 240,
  height: 840,
  x: 0,
  y: 60,
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
  document.body.innerHTML = '<nav class="sidebar"></nav><aside id="ask-dock"></aside>';
  const dock = document.getElementById('ask-dock');
  if (dock) dock.getBoundingClientRect = () => DOCK_RECT as DOMRect;
  const side = document.querySelector('nav.sidebar');
  if (side) (side as HTMLElement).getBoundingClientRect = () => SIDEBAR_RECT as DOMRect;
  // Indirect eval defines initFileDropZone (+ collectDroppedFiles) on the global; the
  // internal __fileDropWired guard makes the wiring idempotent across tests (one listener
  // set, which reads the freshly-reassigned global stubs on each drop).
  (0, eval)(askLatticeJs as string);
  w.initFileDropZone();
});

// Let the async collectDroppedFiles().then() chain settle before asserting.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function drop(x: number, y: number, dt?: unknown): void {
  const ev = new Event('drop', { bubbles: true, cancelable: true }) as Event & {
    dataTransfer: unknown;
    clientX: number;
    clientY: number;
  };
  ev.dataTransfer = dt ?? { types: ['Files'], files: [{ name: 'a.pdf' }] };
  ev.clientX = x;
  ev.clientY = y;
  document.dispatchEvent(ev);
}

describe('file drag-drop scope by view', () => {
  it('Analytics: a file dropped ONTO the chat window is staged (not ingested)', async () => {
    analytics = true;
    drop(900, 400); // inside #ask-dock
    await flush();
    expect(w.stageFiles).toHaveBeenCalledTimes(1);
    expect(w.uploadFiles).not.toHaveBeenCalled();
  });

  it('Analytics: a file dropped OUTSIDE the chat window (dashboards) is ignored', async () => {
    analytics = true;
    drop(100, 400); // left of #ask-dock
    await flush();
    expect(w.stageFiles).not.toHaveBeenCalled();
    expect(w.uploadFiles).not.toHaveBeenCalled();
  });

  it('Configure: a file dropped ONTO the Inputs column ingests immediately', async () => {
    analytics = false;
    drop(120, 400); // inside nav.sidebar
    await flush();
    expect(w.uploadFiles).toHaveBeenCalledTimes(1);
    expect(w.stageFiles).not.toHaveBeenCalled();
  });

  it('Configure: a file dropped OUTSIDE the Inputs column (Model / Outputs) is ignored', async () => {
    analytics = false;
    drop(600, 400); // right of nav.sidebar
    await flush();
    expect(w.uploadFiles).not.toHaveBeenCalled();
    expect(w.stageFiles).not.toHaveBeenCalled();
  });

  it('falls back to the flat file list when webkitGetAsEntry yields no entry', async () => {
    // A synthetic DataTransfer (and some real drops) expose `items` whose
    // webkitGetAsEntry() returns null; the files must still be picked up from
    // `dt.files`, never silently dropped.
    analytics = true; // stage into the composer
    const dt = {
      types: ['Files'],
      files: [{ name: 'memo.md' }],
      items: [{ webkitGetAsEntry: () => null }],
    };
    drop(900, 400, dt); // inside #ask-dock
    await flush();
    expect(w.stageFiles).toHaveBeenCalledTimes(1);
    const arg = w.stageFiles.mock.calls[0]?.[0] as { name: string }[];
    expect(arg.map((f) => f.name)).toEqual(['memo.md']);
  });

  it('a dropped FOLDER is expanded into its files via the Entries API', async () => {
    analytics = false;
    const fileA = { name: 'x.pdf' };
    const fileB = { name: 'y.csv' };
    // A directory entry whose reader serves two file entries, then an empty batch.
    const dirEntry = {
      isFile: false,
      isDirectory: true,
      createReader: () => {
        let served = false;
        return {
          readEntries: (cb: (batch: unknown[]) => void) => {
            if (served) {
              cb([]);
              return;
            }
            served = true;
            cb([
              {
                isFile: true,
                isDirectory: false,
                file: (ok: (f: unknown) => void) => {
                  ok(fileA);
                },
              },
              {
                isFile: true,
                isDirectory: false,
                file: (ok: (f: unknown) => void) => {
                  ok(fileB);
                },
              },
            ]);
          },
        };
      },
    };
    const dt = {
      types: ['Files'],
      files: [],
      items: [{ webkitGetAsEntry: () => dirEntry }],
    };
    drop(120, 400, dt); // inside nav.sidebar
    await flush();
    expect(w.uploadFiles).toHaveBeenCalledTimes(1);
    const arg = w.uploadFiles.mock.calls[0]?.[0] as { name: string }[];
    expect(arg.map((f) => f.name)).toEqual(['x.pdf', 'y.csv']);
  });
});
