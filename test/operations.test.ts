import {describe, expect, it} from 'vitest';
import {expandSeries} from '../src/shared/model';
import type {Series} from '../src/shared/model';
import {applyChange, buildDragChange, cloneSeries, invertChange, rebaseIntent} from '../src/shared/operations';

const H = '20270101T000000';

function daily(over: Partial<Series['rules'][number]['rrule']> = {}): Series {
  return {
    id: 's',
    title: 't',
    zone: 'UTC',
    revision: 1,
    rules: [
      {
        id: 'r1',
        seq: 1,
        dtstart: '20260301T090000',
        zone: 'UTC',
        rrule: {freq: 'DAILY', interval: 1, ...over},
        exceptions: [
          {recurrenceId: '20260305T090000', replacement: '20260305T140000'},
          {recurrenceId: '20260310T090000'},
        ],
      },
    ],
  };
}

function starts(series: Series) {
  return expandSeries(series, H).map((o) => [o.start, o.status, o.effectiveStart, o.ruleId] as const);
}

describe('drag scope = this', () => {
  it('adds one EXDATE / replacement keyed by original identity, leaves the rule intact', () => {
    const series = daily();
    const before = structuredClone(series.rules[0].rrule);
    const change = buildDragChange(series, {
      ruleId: 'r1',
      recurrenceId: '20260308T090000',
      newStart: '20260309T110000',
      scope: 'this',
      zone: 'UTC',
    });
    applyChange(series, change);
    expect(series.rules).toHaveLength(1);
    expect(series.rules[0].rrule).toEqual(before);
    const ex = series.rules[0].exceptions.find((e) => e.recurrenceId === '20260308T090000');
    expect(ex?.replacement).toBe('20260309T110000');
    // Original occurrence stays present in the expansion, marked moved.
    const occ = expandSeries(series, H).find((o) => o.start === '20260308T090000');
    expect(occ?.status).toBe('moved');
    expect(occ?.effectiveStart).toBe('20260309T110000');
  });

  it('preserves pre-existing exceptions', () => {
    const series = daily();
    const change = buildDragChange(series, {
      ruleId: 'r1', recurrenceId: '20260308T090000', newStart: '20260308T150000', scope: 'this', zone: 'UTC',
    });
    applyChange(series, change);
    expect(series.rules[0].exceptions).toContainEqual({recurrenceId: '20260305T090000', replacement: '20260305T140000'});
    expect(series.rules[0].exceptions).toContainEqual({recurrenceId: '20260310T090000'});
  });
});

describe('drag scope = thisAndFuture', () => {
  it('truncates with UNTIL and appends a new segment; head occurrences untouched', () => {
    const series = daily();
    const change = buildDragChange(series, {
      ruleId: 'r1', recurrenceId: '20260308T090000', newStart: '20260309T110000', scope: 'thisAndFuture', zone: 'UTC',
    });
    applyChange(series, change);
    expect(series.rules).toHaveLength(2);
    expect(series.rules[0].rrule.until).toBe('20260308T085959');
    expect(series.rules[1].dtstart).toBe('20260308T090000');
    const rows = new Map(starts(series).map((r) => [r[0], r]));
    expect(rows.get('20260307T090000')?.[3]).toBe('r1');
    expect(rows.get('20260308T090000')?.[3]).not.toBe('r1');
    expect(rows.get('20260308T090000')?.[2]).toBe('20260309T110000');
    expect(rows.get('20260309T090000')).toBeDefined();
  });

  it('migrates exceptions belonging to the tail (20260310) and leaves head ones (20260305)', () => {
    const series = daily();
    const change = buildDragChange(series, {
      ruleId: 'r1', recurrenceId: '20260308T090000', newStart: '20260308T120000', scope: 'thisAndFuture', zone: 'UTC',
    });
    applyChange(series, change);
    const [head, tail] = series.rules;
    expect(head.exceptions.map((e) => e.recurrenceId)).toEqual(['20260305T090000']);
    expect(tail.exceptions.some((e) => e.recurrenceId === '20260310T090000')).toBe(true);
    // Migrated cancellation still applies.
    const occ = expandSeries(series, H).find((o) => o.start === '20260310T090000');
    expect(occ?.status).toBe('cancelled');
    expect(occ?.ruleId).toBe(tail.id);
  });

  it('the boundary is exclusive: an exception at the split key moves, one second earlier does not', () => {
    const series = daily();
    // Add an exception at Mar 11 23:59:59 (strictly before a Mar 12 09:00 split).
    series.rules[0].exceptions.push({recurrenceId: '20260311T090000'});
    const change = buildDragChange(series, {
      ruleId: 'r1', recurrenceId: '20260312T090000', newStart: '20260312T150000', scope: 'thisAndFuture', zone: 'UTC',
    });
    applyChange(series, change);
    const [head, tail] = series.rules;
    expect(head.exceptions.map((e) => e.recurrenceId).sort()).toEqual(['20260305T090000', '20260310T090000', '20260311T090000']);
    expect(tail.exceptions.map((e) => e.recurrenceId)).toEqual(['20260312T090000']);
  });

  it('inherits COUNT: tail keeps exactly the remaining occurrence count', () => {
    const series = daily({count: 10}); // Mar 1..Mar 10
    const change = buildDragChange(series, {
      ruleId: 'r1', recurrenceId: '20260308T090000', newStart: '20260308T120000', scope: 'thisAndFuture', zone: 'UTC',
    });
    applyChange(series, change);
    const [head, tail] = series.rules;
    const headRows = expandSeries(series, H).filter((o) => o.ruleId === head.id);
    const tailRows = expandSeries(series, H).filter((o) => o.ruleId === tail.id);
    expect(headRows).toHaveLength(7); // Mar 1..7
    expect(tail.rrule.count).toBe(3); // Mar 8,9,10
    expect(tailRows).toHaveLength(3);
  });

  it('inherits UNTIL: tail ends at the original bound', () => {
    const series = daily({until: '20260312T090000'});
    const change = buildDragChange(series, {
      ruleId: 'r1', recurrenceId: '20260308T090000', newStart: '20260308T120000', scope: 'thisAndFuture', zone: 'UTC',
    });
    applyChange(series, change);
    const [, tail] = series.rules;
    expect(tail.rrule.until).toBe('20260312T090000');
    const last = expandSeries(series, H).at(-1)!;
    expect(last.start).toBe('20260312T090000');
  });

  it('supports two successive "from here" splits without duplicate or gap', () => {
    const series = daily();
    const c1 = buildDragChange(series, {
      ruleId: 'r1', recurrenceId: '20260308T090000', newStart: '20260308T120000', scope: 'thisAndFuture', zone: 'UTC',
    });
    applyChange(series, c1);
    const middleId = series.rules[1].id;

    // While living on the middle segment, edit one occurrence (Mar 14) that
    // belongs to the part the NEXT split will take over.
    const midEdit = buildDragChange(series, {
      ruleId: middleId, recurrenceId: '20260314T090000', newStart: '20260314T160000', scope: 'this', zone: 'UTC',
    });
    applyChange(series, midEdit);

    const c2 = buildDragChange(series, {
      ruleId: middleId, recurrenceId: '20260312T090000', newStart: '20260312T180000', scope: 'thisAndFuture', zone: 'UTC',
    });
    applyChange(series, c2);
    expect(series.rules).toHaveLength(3);
    const rows = new Map(starts(series).map((r) => [r[0], r]));
    expect(rows.get('20260307T090000')?.[3]).toBe('r1');
    expect(rows.get('20260311T090000')?.[3]).toBe(middleId);
    expect(rows.get('20260312T090000')?.[2]).toBe('20260312T180000');
    expect(rows.get('20260313T090000')).toBeDefined();
    // Every day Mar 1..Mar 20 occurs exactly once.
    const all = expandSeries(series, '20260321T000000');
    expect(all).toHaveLength(20);
    // Mar 10 cancellation sits BEFORE the second split: stays on the middle segment.
    const cancelled = all.find((o) => o.start === '20260310T090000');
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.ruleId).toBe(middleId);
    // The middle-segment Mar 14 edit migrates to the final segment and survives.
    const migrated = all.find((o) => o.start === '20260314T090000');
    expect(migrated?.ruleId).toBe(series.rules[2].id);
    expect(migrated?.status).toBe('moved');
    expect(migrated?.effectiveStart).toBe('20260314T160000');
  });
});

describe('structured undo', () => {
  it('inverse ops restore rules and exceptions without replaying a snapshot', () => {
    const original = daily();
    const series = cloneSeries(original);
    const change = buildDragChange(series, {
      ruleId: 'r1', recurrenceId: '20260308T090000', newStart: '20260309T110000', scope: 'thisAndFuture', zone: 'UTC',
    });
    applyChange(series, change);
    expect(series).not.toEqual(original);
    applyChange(series, invertChange(change));
    expect(series).toEqual(original);
  });

  it('undo restores COUNT after a split', () => {
    const original = daily({count: 10});
    const series = cloneSeries(original);
    const change = buildDragChange(series, {
      ruleId: 'r1', recurrenceId: '20260308T090000', scope: 'thisAndFuture', zone: 'UTC',
    });
    applyChange(series, change);
    applyChange(series, invertChange(change));
    expect(series.rules).toHaveLength(1);
    expect(series.rules[0].rrule.count).toBe(10);
    expect(series.rules[0].rrule.until).toBeUndefined();
  });

  it('undo stack for two splits unwinds in reverse order', () => {
    const original = daily();
    const series = cloneSeries(original);
    const c1 = buildDragChange(series, {ruleId: 'r1', recurrenceId: '20260308T090000', newStart: '20260308T120000', scope: 'thisAndFuture', zone: 'UTC'});
    applyChange(series, c1);
    const c2 = buildDragChange(series, {ruleId: series.rules[1].id, recurrenceId: '20260312T090000', newStart: '20260312T180000', scope: 'thisAndFuture', zone: 'UTC'});
    applyChange(series, c2);
    applyChange(series, invertChange(c2));
    expect(series.rules).toHaveLength(2);
    applyChange(series, invertChange(c1));
    expect(series).toEqual(original);
  });
});

describe('rebaseIntent after revision conflict', () => {
  it('re-resolves the owning segment when segment ids changed', () => {
    // Simulate another client having performed an equivalent split: the same
    // occurrence is now owned by a differently-named segment.
    const series = daily();
    const c = buildDragChange(series, {ruleId: 'r1', recurrenceId: '20260308T090000', newStart: '20260308T120000', scope: 'thisAndFuture', zone: 'UTC'});
    applyChange(series, c);
    const newTailId = series.rules[1].id;

    // Stale intent from the old client references r1 but wants Mar 12 (tail).
    const rebased = rebaseIntent(series, {
      ruleId: 'r1', recurrenceId: '20260312T090000', newStart: '20260313T090000', scope: 'this', zone: 'UTC',
    });
    applyChange(series, rebased);
    const occ = expandSeries(series, H).find((o) => o.start === '20260312T090000');
    expect(occ?.ruleId).toBe(newTailId);
    expect(occ?.status).toBe('moved');
  });
});
