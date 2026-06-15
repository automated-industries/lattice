// Re-exported from the package root so existing `gui/concurrency` importers keep
// working while the implementation lives in a neutral module the render engine
// can also use (without inverting the gui → render dependency direction).
export { mapWithConcurrency } from '../concurrency.js';
