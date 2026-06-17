/**
 * Shared route-path regexes for the `/api/tables/:table/rows*` family. A pure
 * leaf with zero imports so it can be shared by both the surviving CRUD
 * dispatcher in server.ts and the extracted read dispatcher in read-routes.ts
 * without introducing a cycle.
 *
 * The ordering between these is load-bearing where they overlap:
 * `/api/tables/foo/rows/123/context` matches BOTH CONTEXT_PATH and ROWS_PATH
 * (ROWS captures id=`123/context`), and likewise for ROW_HISTORY_PATH — so the
 * read dispatcher MUST test CONTEXT_PATH / ROW_HISTORY_PATH before server.ts
 * reaches its surviving ROWS_PATH test. LAST_EDITED_PATH does not overlap
 * ROWS_PATH; it lives here for cohesion with the rest of the family.
 *
 * LINK_PATH stays local in server.ts — only the link/unlink write block uses it.
 */
export const ROWS_PATH = /^\/api\/tables\/([^/]+)\/rows(?:\/(.+))?$/;
export const CONTEXT_PATH = /^\/api\/tables\/([^/]+)\/rows\/([^/]+)\/context$/;
export const ROW_HISTORY_PATH = /^\/api\/tables\/([^/]+)\/rows\/([^/]+)\/history$/;
export const LAST_EDITED_PATH = /^\/api\/tables\/([^/]+)\/last-edited$/;
