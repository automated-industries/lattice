// @vitest-environment jsdom
/**
 * Search drives the brain graph's highlight.
 *
 * The force renderer has always owned a highlight mode — it pulses the matched
 * nodes, dims everything else, and frames the matches (the warm stroke the graph
 * stylesheet calls the search-highlight pulse). Nothing ever called it, so
 * searching lit nothing up. These tests cover the seam that connects the one
 * workspace search endpoint to that one highlight entry point: no second search
 * implementation, no second highlight mechanism.
 *
 * Node identity differs per graph, so the mapping does too: the schema graph's
 * nodes ARE tables, while a drilled-in entity graph's nodes are that table's rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { systemTablesJs } from '../../src/gui/app/modules/system-tables.js';
import { searchJs } from '../../src/gui/app/modules/search.js';

interface SearchHit {
  id: string;
  snippet?: string;
}
interface SearchGroup {
  table: string;
  hits: SearchHit[];
}
interface SearchResult {
  query: string;
  groups: SearchGroup[];
}

interface GraphSearchApi {
  graphSearchHighlight: (query: string | null) => Promise<string[] | null>;
  graphSearchNodeIds: (result: unknown) => string[];
  mountGraphSearch: () => HTMLInputElement | null;
  graphSearchReapply: () => void;
  graphSearchQuery: string;
  currentGraphKey: string | null;
  schemaGraphHandle: unknown;
  fetchJson: (url: string) => Promise<unknown>;
}

/** Every highlight the renderer was handed, in order. */
let highlights: (string[] | null)[] = [];
/** Every URL the search seam fetched, in order. */
let fetched: string[] = [];
/** Every toast raised (a failed search must be surfaced, never swallowed). */
let toasts: string[] = [];

const result = (...groups: SearchGroup[]): SearchResult => ({ query: 'q', groups });

/** Compose the two client segments into this global scope with faithful stubs
 *  for the collaborators they reach for, then hand back the resulting globals. */
function load(graphKey: string | null): GraphSearchApi {
  highlights = [];
  fetched = [];
  toasts = [];
  document.body.innerHTML = '';
  const g = globalThis as unknown as GraphSearchApi & Record<string, unknown>;
  g.fetchJson = (url: string) => {
    fetched.push(url);
    return Promise.resolve(result());
  };
  g.showToast = (msg: string) => {
    toasts.push(msg);
  };
  g.escapeHtml = (s: string) => s;
  (0, eval)(systemTablesJs as string);
  (0, eval)(searchJs as string);
  g.schemaGraphHandle = {
    setHighlight: (ids: string[] | null) => {
      highlights.push(ids);
    },
    setSelected: () => {},
    setData: () => {},
    positions: () => ({}),
    stop: () => {},
  };
  g.currentGraphKey = graphKey;
  return g;
}

/** Let the search promise chain settle under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('graph search highlight — mapping hits onto the mounted graph', () => {
  it('highlights the tables that matched on the schema graph', async () => {
    const api = load('schema');
    api.fetchJson = (url: string) => {
      fetched.push(url);
      return Promise.resolve(
        result(
          { table: 'invoices', hits: [{ id: 'i1' }, { id: 'i2' }] },
          { table: 'people', hits: [] }, // a group with no hits is not a match
          { table: 'files', hits: [{ id: 'f1' }] },
        ),
      );
    };

    const ids = await api.graphSearchHighlight('acme');

    expect(fetched).toEqual(['/api/search?q=acme']);
    expect(ids).toEqual(['invoices', 'files']);
    expect(highlights).toEqual([['invoices', 'files']]);
  });

  it('highlights the matching ROWS on a drilled-in entity graph', async () => {
    const api = load('entity:invoices');
    api.fetchJson = () =>
      Promise.resolve(
        result(
          { table: 'invoices', hits: [{ id: 'i1' }, { id: 'i2' }] },
          { table: 'people', hits: [{ id: 'p1' }] }, // another table's rows are not nodes here
        ),
      );

    const ids = await api.graphSearchHighlight('acme');

    expect(ids).toEqual(['i1', 'i2']);
    expect(highlights).toEqual([['i1', 'i2']]);
  });

  it('encodes the query so a search with spaces or symbols reaches the endpoint intact', async () => {
    const api = load('schema');
    await api.graphSearchHighlight('acme & co');
    expect(fetched).toEqual(['/api/search?q=acme%20%26%20co']);
  });

  it('highlights nothing when the search matched nothing', async () => {
    const api = load('schema');
    const ids = await api.graphSearchHighlight('nothing-matches-this');
    expect(ids).toEqual([]);
    expect(highlights).toEqual([[]]);
  });
});

describe('graph search highlight — clearing the search clears the highlight', () => {
  it('clears the highlight on an empty query, without searching', async () => {
    const api = load('schema');
    await api.graphSearchHighlight('acme');
    expect(fetched).toHaveLength(1);

    const cleared = await api.graphSearchHighlight('');

    expect(cleared).toBeNull();
    expect(fetched).toHaveLength(1); // no request for a blank query
    expect(highlights[highlights.length - 1]).toBeNull(); // null restores every node
    expect(api.graphSearchQuery).toBe('');
  });

  it('treats a whitespace-only query as cleared', async () => {
    const api = load('schema');
    await api.graphSearchHighlight('   ');
    expect(fetched).toEqual([]);
    expect(highlights).toEqual([null]);
  });

  it('clears without throwing when no graph is mounted', async () => {
    const api = load('schema');
    (api as Record<string, unknown>).schemaGraphHandle = null;
    await expect(api.graphSearchHighlight('')).resolves.toBeNull();
    expect(highlights).toEqual([]);
  });
});

describe('graph search highlight — a stale response never wins', () => {
  it('drops an earlier search that resolves after a later one', async () => {
    const api = load('schema');
    const pending: ((value: SearchResult) => void)[] = [];
    api.fetchJson = (url: string) => {
      fetched.push(url);
      return new Promise<SearchResult>((resolve) => pending.push(resolve));
    };

    const first = api.graphSearchHighlight('ac');
    const second = api.graphSearchHighlight('acme');
    expect(fetched).toEqual(['/api/search?q=ac', '/api/search?q=acme']);

    // The newer query answers first, then the older one straggles in.
    pending[1](result({ table: 'invoices', hits: [{ id: 'i1' }] }));
    pending[0](result({ table: 'people', hits: [{ id: 'p1' }] }));
    await Promise.all([first, second]);

    expect(highlights).toEqual([['invoices']]); // the straggler was discarded
  });

  it('drops a response that lands after the search was cleared', async () => {
    const api = load('schema');
    const pending: ((value: SearchResult) => void)[] = [];
    api.fetchJson = () => new Promise<SearchResult>((resolve) => pending.push(resolve));

    const search = api.graphSearchHighlight('acme');
    await api.graphSearchHighlight(''); // user cleared the field mid-flight
    pending[0](result({ table: 'invoices', hits: [{ id: 'i1' }] }));
    await search;

    expect(highlights).toEqual([null]); // cleared, and never re-lit by the straggler
  });
});

describe('graph search highlight — a failed search is surfaced, not swallowed', () => {
  it('rejects so the caller can report it', async () => {
    const api = load('schema');
    api.fetchJson = () => Promise.reject(new Error('offline'));
    await expect(api.graphSearchHighlight('acme')).rejects.toThrow('offline');
    expect(highlights).toEqual([]); // no fabricated "nothing matched" result
  });
});

describe('graph search field — the control that drives the seam', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The toolbar the graph views render; the field mounts into it. */
  function toolbar(): void {
    document.body.innerHTML =
      '<div class="graph-toolbar">' +
      '<span class="graph-tools-spacer"></span>' +
      '<button id="wm-wire-btn"></button>' +
      '</div>';
  }

  it('mounts one field into the graph toolbar, ahead of the tool buttons', () => {
    const api = load('schema');
    toolbar();

    const input = api.mountGraphSearch();
    expect(input).not.toBeNull();
    expect(document.querySelectorAll('#graph-search-input')).toHaveLength(1);
    // Ahead of the spacer, so it sits with the view's own controls.
    const bar = document.querySelector('.graph-toolbar')!;
    expect(bar.children[0].id).toBe('graph-search-input');

    api.mountGraphSearch(); // a re-render must not stack duplicates
    expect(document.querySelectorAll('#graph-search-input')).toHaveLength(1);
  });

  it('does nothing when there is no toolbar to mount into', () => {
    const api = load('schema');
    expect(api.mountGraphSearch()).toBeNull();
  });

  it('highlights the matches as the user types, once typing settles', async () => {
    const api = load('schema');
    toolbar();
    api.fetchJson = (url: string) => {
      fetched.push(url);
      return Promise.resolve(result({ table: 'invoices', hits: [{ id: 'i1' }] }));
    };
    const input = api.mountGraphSearch()!;

    input.value = 'ac';
    input.dispatchEvent(new Event('input'));
    input.value = 'acme';
    input.dispatchEvent(new Event('input'));
    expect(fetched).toEqual([]); // debounced — not one request per keystroke

    vi.advanceTimersByTime(500);
    await flush();

    expect(fetched).toEqual(['/api/search?q=acme']);
    expect(highlights).toEqual([['invoices']]);
  });

  it('clears the highlight the moment the field is emptied', async () => {
    const api = load('schema');
    toolbar();
    api.fetchJson = () => Promise.resolve(result({ table: 'invoices', hits: [{ id: 'i1' }] }));
    const input = api.mountGraphSearch()!;

    input.value = 'acme';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(500);
    await flush();
    expect(highlights).toEqual([['invoices']]);

    input.value = '';
    input.dispatchEvent(new Event('input'));
    await flush();
    expect(highlights[highlights.length - 1]).toBeNull(); // immediate, not debounced
  });

  it('restores the live query when a re-render rebuilds the toolbar', async () => {
    const api = load('schema');
    toolbar();
    api.mountGraphSearch();
    await api.graphSearchHighlight('acme');

    toolbar(); // the view re-rendered; the old field is gone
    const input = api.mountGraphSearch()!;
    expect(input.value).toBe('acme');
  });

  it('does not re-light a graph view that has no field to clear it', async () => {
    // A graph can mount without the toolbar. Re-applying the query there would
    // dim the graph with nothing on screen to explain or undo it, so the query is
    // dropped instead.
    const api = load('schema');
    toolbar();
    api.mountGraphSearch();
    await api.graphSearchHighlight('acme');
    highlights.length = 0;

    document.body.innerHTML = ''; // re-rendered into a view with no toolbar
    api.graphSearchReapply();

    expect(highlights).toEqual([]);
    expect(api.graphSearchQuery).toBe('');
  });

  it('surfaces a failed search instead of leaving a stale highlight unexplained', async () => {
    const api = load('schema');
    toolbar();
    api.fetchJson = () => Promise.reject(new Error('offline'));
    const input = api.mountGraphSearch()!;

    input.value = 'acme';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(500);
    await flush();

    expect(toasts.join(' ')).toContain('offline');
  });
});
