import { describe, it, expect } from 'vitest';
import { findStatedCountMismatches, statedCountNotices } from '../../src/gui/import-auto.js';

/**
 * A document frequently states how many things it contains ("46 schools", "a
 * total of 120 invoices"). When extraction produces FEWER rows than the document
 * itself claims, that gap is the single most important thing to tell the user —
 * it is the difference between "imported" and "imported a third of it". These
 * tests pin the detector: it fires on a real shortfall, matches the stated noun
 * to a real extracted table, and stays quiet everywhere else (an over-count, a
 * noun that is not a table, a year, a page number).
 */
describe('stated-count reconciliation', () => {
  it('reports a shortfall when the document states more than extraction produced', () => {
    const text = 'The district operates 46 schools across three regions.';
    const m = findStatedCountMismatches(text, { schools: 12 });
    expect(m).toHaveLength(1);
    expect(m[0]?.stated).toBe(46);
    expect(m[0]?.extracted).toBe(12);
    expect(m[0]?.table).toBe('schools');
  });

  it('renders the shortfall as a human notice naming both numbers and the table', () => {
    const notices = statedCountNotices('The district operates 46 schools.', { schools: 12 });
    expect(notices).toHaveLength(1);
    const n = notices[0] ?? '';
    expect(n).toContain('46');
    expect(n).toContain('12');
    expect(n).toContain('schools');
  });

  it('stays silent when the stated count matches what was extracted', () => {
    expect(findStatedCountMismatches('There are 46 schools.', { schools: 46 })).toEqual([]);
  });

  it('stays silent when extraction produced MORE than the document stated', () => {
    // A document may state a subset ("12 schools in the north region") while the
    // table legitimately holds every school. Only a SHORTFALL is a data-loss signal.
    expect(findStatedCountMismatches('12 schools in the north region.', { schools: 46 })).toEqual(
      [],
    );
  });

  it('ignores a stated count whose subject matches no extracted table', () => {
    // Without the table-match requirement every "3 reasons" / "2 options" in prose
    // would raise a false alarm.
    expect(findStatedCountMismatches('There are 3 reasons for this.', { schools: 12 })).toEqual([]);
  });

  it('matches a plural noun against a singular table name and vice versa', () => {
    expect(findStatedCountMismatches('46 schools', { school: 12 })).toHaveLength(1);
    expect(findStatedCountMismatches('46 invoice records', { invoice_records: 4 })).toHaveLength(1);
  });

  it('matches a multi-word subject against a multi-word table name', () => {
    const m = findStatedCountMismatches('the list covers 46 charter schools', {
      charter_schools: 9,
    });
    expect(m).toHaveLength(1);
    expect(m[0]?.table).toBe('charter_schools');
  });

  it('does not read a year as a count', () => {
    // "In 2024 schools reported…" is a date, not a quantity.
    expect(
      findStatedCountMismatches('In 2024 schools reported new figures.', { schools: 12 }),
    ).toEqual([]);
  });

  it('does not read a decimal or a thousands-grouped fragment as a count', () => {
    expect(findStatedCountMismatches('Growth was 4.6 schools per year.', { schools: 2 })).toEqual(
      [],
    );
    // A grouped number is read whole (1,046) rather than as a stray "046".
    const m = findStatedCountMismatches('1,046 schools', { schools: 12 });
    expect(m[0]?.stated).toBe(1046);
  });

  it('reports the largest stated count once per table rather than one notice per mention', () => {
    const text =
      'There are 46 schools. Of those, 30 schools are elementary. All 46 schools report.';
    const m = findStatedCountMismatches(text, { schools: 12 });
    expect(m).toHaveLength(1);
    expect(m[0]?.stated).toBe(46);
  });

  it('reports each shortfalling table when a document states several counts', () => {
    const text = 'The report covers 46 schools and 900 students.';
    const m = findStatedCountMismatches(text, { schools: 12, students: 100 });
    expect(m.map((x) => x.table).sort()).toEqual(['schools', 'students']);
  });

  it('is quiet on an empty document or an empty extraction', () => {
    expect(findStatedCountMismatches('', { schools: 0 })).toEqual([]);
    expect(findStatedCountMismatches('46 schools', {})).toEqual([]);
  });
});
