/** Prefab connector catalog — curated flagship entries + registry-sourced "browse more" metadata. */
export type { CatalogEntry } from './types.js';
export { curatedCatalog } from './curated.js';
export { mergeCatalog } from './merge.js';
export { monogramIcon, resolveIcon } from './icons.js';
export { fetchMcpRegistry, normalizeMcpRegistry } from './mcp-registry.js';
export { fetchSmithery, normalizeSmithery } from './smithery.js';
export {
  PrefabCatalog,
  createPrefabCatalog,
  sharedPrefabCatalog,
  type CatalogSource,
} from './catalog.js';
