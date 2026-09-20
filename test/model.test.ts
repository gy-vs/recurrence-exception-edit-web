import {describe, expect, it} from 'vitest';
import {expandRaw, expandSeries, splitBoundary, validateRule} from '../src/shared/model';
import type {Series} from '../src/shared/model';

const H = '20280101T000000';

describe('expandRaw — COUNT / UNTIL', () => {
  it('COUNT limits the set and DTSTART counts first', () => {
    const out = expandRaw({freq: 'DAILY', interval: 1, count: 3}, '20260301T090000', H);
    expect(out).toEqual(['20260301T090000', '20260302T090000', '20260303T090000']);
  });

  it('COUNT with interval > 1', () => {
    const out = expandRaw({freq: 'DAILY', interval: 2, count: 3}, '20260301T090000', H);
    expect(out).toEqual(['20260301T090000', '20260303T090000', '20260305T090000']);
  });

  it('UNTIL is inclusive and bounds the last occurrence', () => {
    const out = expandRaw(
      {freq: 'WEEKLY', interval: 1, byWeekDay: ['FR'], until: '20260320T110000'},
      '20260306T110000',
      H,
    );
    expect(out).toEqual(['20260306T110000', '20260313T110000', '20260320T110000']);
  });

  it('COUNT and UNTIL together is invalid', () => {
    expect(validateRule({freq: 'DAILY', interval: 1, count: 2, until: '20270101T000000'}, '20260301T090000')).toMatch(/mutually exclusive/);
  });

  it('splitBoundary lands one second before the last generated occurrence', () => {
    expect(splitBoundary({freq: 'DAILY', interval: 1, count: 3}, '20260301T090000'))
      .toBe('20260303T085959');
    expect(splitBoundary({freq: 'DAILY', interval: 1}, '20260301T090000')).toBeNull();
  });
});

describe('expandRaw — monthly invalid dates', () => {
  it('BYMONTHDAY=31 skips short months, never rolls over', () => {
    const out = expandRaw({freq: 'MONTHLY', interval: 1, byMonthDay: [31]}, '20260131T080000', H).slice(0, 5);
    expect(out).toEqual([
      '20260131T080000',
      '20260331T080000', // Feb skipped, March once (no double count)
      '20260531T080000',
      '20260731T080000',
      '20260831T080000',
    ]);
  });

  it('plain MONTHLY started on the 31st also skips February/April', () => {
    const out = expandRaw({freq: 'MONTHLY', interval: 1}, '20260131T080000', H).slice(0, 4);
    expect(out).toEqual(['20260131T080000', '20260331T080000', '20260531T080000', '20260731T080000']);
  });

  it('negative BYMONTHDAY (-1) hits every month-end including Feb 28', () => {
    const out = expandRaw({freq: 'MONTHLY', interval: 1, byMonthDay: [-1]}, '20260131T080000', H).slice(0, 3);
    expect(out).toEqual(['20260131T080000', '20260228T080000', '20260331T080000']);
  });
});

describe('expandSeries — exceptions and segments', () => {
  const series: Series = {
    id: 's',
    title: 't',
    zone: 'UTC',
    revision: 1,
    rules: [
      {
        id: 'a', seq: 1,
        dtstart: '20260301T090000',
        zone: 'UTC',
        rrule: {freq: 'DAILY', interval: 1, until: '20260303T085959'},
        exceptions: [],
      },
      {
        id: 'b', seq: 2,
        dtstart: '20260303T090000',
        zone: 'UTC',
        rrule: {freq: 'DAILY', interval: 2},
        exceptions: [
          {recurrenceId: '20260305T090000', replacement: '20260305T150000'},
          {recurrenceId: '20260307T090000'},
        ],
      },
    ],
  };

  it('keeps rule identity, marks moved/cancelled, later segment wins overlaps', () => {
    const occ = expandSeries(series, '20260309T000000');
    const map = new Map(occ.map((o) => [o.start, o]));
    expect(map.get('20260301T090000')?.ruleId).toBe('a');
    expect(map.get('20260303T090000')?.ruleId).toBe('b');
    expect(map.get('20260305T090000')?.status).toBe('moved');
    expect(map.get('20260305T090000')?.effectiveStart).toBe('20260305T150000');
    expect(map.get('20260307T090000')?.status).toBe('cancelled');
  });

  it('does NOT explode the series into independent records (segments stay rules)', () => {
    const occ = expandSeries(series, '20260309T000000');
    // Segment a ended on the 3rd; the 4th must not exist (b runs every 2 days from the 3rd).
    expect(occ.find((o) => o.start === '20260304T090000')).toBeUndefined();
    expect(occ.find((o) => o.start === '20260306T090000')).toBeUndefined();
  });
});
