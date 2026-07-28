import { describe, expect, it } from 'vitest';
import { inlineImportJs } from '../../src/gui/app/modules/inline-import.js';

// The silent structured-import executor posts to /api/import/apply. For a brand-new dataset that
// carries a confidently-detected file-level date, the client must FORWARD that date
// (autoImport.asOf) so the apply route files the rows under the document's own reporting date
// rather than the day the import happened to run. This guards the regression where the client
// dropped the detected date and always sent an empty asOf (which the route then read as "undated"
// and stamped with the import day).
describe('inline import: silent apply forwards the detected file-level date', () => {
  const norm = inlineImportJs.replace(/\s+/g, ' ');

  it('sends autoImport.asOf (empty-string fallback) as the apply date', () => {
    expect(norm).toContain('asOf: autoImport.asOf ||');
    // It posts to the apply route (so this is the payload that route reads).
    expect(norm).toContain('/api/import/apply');
  });
});
