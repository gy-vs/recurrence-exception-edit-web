import {describe, expect, it} from 'vitest';
import {auditDst} from '../src/shared/dst';
import {expandSeries} from '../src/shared/model';
import type {Series} from '../src/shared/model';
import {wallToInstant} from '../src/shared/wall';

describe('wall time resolution across DST', () => {
  it('keeps a fixed wall time but reports the offset switch', () => {
    const before = wallToInstant({y: 2026, mo: 3, d: 5, h: 9, mi: 0, s: 0}, 'America/New_York');
    const after = wallToInstant({y: 2026, mo: 3, d: 9, h: 9, mi: 0, s: 0}, 'America/New_York');
    expect(before.kind).toBe('normal');
    expect(before.offsetMs).toBe(-5 * 3_600_000);
    expect(after.offsetMs).toBe(-4 * 3_600_000);
  });

  it('flags a spring-forward gap and resolves forward', () => {
    // US 2026: clocks jump 02:00 EST -> 03:00 EDT on March 8.
    const r = wallToInstant({y: 2026, mo: 3, d: 8, h: 2, mi: 30, s: 0}, 'America/New_York');
    expect(r.kind).toBe('gap');
    expect(r.instantMs).toBe(Date.UTC(2026, 2, 8, 7, 30, 0)); // 02:30 EST == 03:30 EDT
  });

  it('flags a fall-back overlap and chooses the earlier instant', () => {
    // US 2026: clocks 02:00 EDT -> 01:00 EST on November 1.
    const r = wallToInstant({y: 2026, mo: 11, d: 1, h: 1, mi: 30, s: 0}, 'America/New_York');
    expect(r.kind).toBe('overlap');
    expect(r.offsetMs).toBe(-4 * 3_600_000); // earlier = EDT
    expect(new Date(r.instantMs).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('is a no-op for UTC series', () => {
    const r = wallToInstant({y: 2026, mo: 3, d: 8, h: 2, mi: 30, s: 0}, 'UTC');
    expect(r.kind).toBe('normal');
    expect(r.offsetMs).toBe(0);
  });
});

describe('auditDst over a series crossing the boundary', () => {
  const series: Series = {
    id: 's', title: 't', zone: 'America/New_York', revision: 1,
    rules: [
      {
        id: 'r1', seq: 1, dtstart: '20260305T090000', zone: 'America/New_York',
        rrule: {freq: 'DAILY', interval: 1, count: 6}, exceptions: [],
      },
    ],
  };

  it('emits a crossing note at the first occurrence under the new offset', () => {
    const occ = expandSeries(series, '20270101T000000');
    const notes = auditDst(occ, 'America/New_York');
    const crossing = notes.find((n) => n.crossesBoundary);
    expect(crossing).toBeDefined();
    expect(crossing!.start).toBe('20260308T090000');
    expect(crossing!.message).toMatch(/crosses DST boundary/);
  });

  it('drag keeps the wall time; the audit still flags the crossing', () => {
    const moved: Series = {
      ...series,
      rules: [
        {
          ...series.rules[0],
          exceptions: [{recurrenceId: '20260307T090000', replacement: '20260307T100000'}],
        },
      ],
    };
    const occ = expandSeries(moved, '20270101T000000');
    const notes = auditDst(occ, 'America/New_York');
    expect(notes.some((n) => n.start === '20260308T090000' && n.crossesBoundary)).toBe(true);
  });
});
