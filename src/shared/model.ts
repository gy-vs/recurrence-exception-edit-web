import {Wall, addCalendarMonth, addDays, addMonths, compareWall, dayOfWeek, daysInMonth, isoWall, parseWall, previousSecond, wallKey} from './wall';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export type RRule = {
  freq: Freq;
  interval: number; // >= 1
  /** Mondays = MO .. Sundays = SU. Empty means "start day" semantics. */
  byWeekDay?: string[];
  /** Only for MONTHLY; when absent the start day-of-month is used. */
  byMonthDay?: number[];
  count?: number;
  until?: string; // inclusive wall time; DTSTART itself never belongs to the tail
};

export type Exception = {
  /** Original occurrence identity, i.e. the rule-generated wall time. */
  recurrenceId: string;
  /** Replacement occurrence. Absent => the occurrence is cancelled (EXDATE). */
  replacement?: string;
};

/**
 * One segment of a recurrence chain. Editing "this and all following" truncates
 * the current rule and appends a new rule; `inherited` carries exception
 * identity context across segments so old occurrences stay recognisable.
 */
export type Rule = {
  id: string;
  /** Position in the chain. Needed because split segments can share a DTSTART. */
  seq: number;
  rrule: RRule;
  dtstart: string;
  zone: string;
  /**
   * Exceptions whose recurrence-id belongs to this segment. The id is the wall
   * time at which THIS segment would generate the occurrence.
   */
  exceptions: Exception[];
};

export type Series = {
  id: string;
  title: string;
  zone: string;
  rules: Rule[];
  /** Bumped on every persisted change; saves must echo the revision they saw. */
  revision: number;
};

export type Occurrence = {
  /** Absolute identity: originating rule id + original wall key. */
  uid: string;
  /** Rule segment that produced this occurrence. */
  ruleId: string;
  /** Original wall time (post any inherited-id remap). */
  start: string;
  /** Effective wall time: replacement if excepted, otherwise start. */
  effectiveStart: string;
  status: 'ok' | 'moved' | 'cancelled';
};

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

const JS_TO_ICAL = [6, 0, 1, 2, 3, 4, 5]; // JS getUTCDay 0..6 -> index into WEEKDAYS

export function weekdayOf(w: Wall): string {
  return WEEKDAYS[JS_TO_ICAL[dayOfWeek(w)]];
}

export function validateRule(r: RRule, dtstart: string): string | null {
  if (r.interval < 1 || !Number.isInteger(r.interval)) return 'interval must be a positive integer';
  const start = parseWall(dtstart);
  if (r.byWeekDay) {
    if (!r.byWeekDay.every((d) => WEEKDAYS.includes(d))) return 'invalid BYDAY';
  }
  if (r.byMonthDay) {
    for (const d of r.byMonthDay) {
      if (!Number.isInteger(d) || d < -31 || d > 31 || d === 0) return 'invalid BYMONTHDAY';
    }
  }
  if (r.until) {
    if (compareWall(parseWall(r.until), start) < 0) return 'UNTIL is before DTSTART';
  }
  if (r.count !== undefined && r.until !== undefined) return 'COUNT and UNTIL are mutually exclusive';
  if (r.count !== undefined && r.count < 1) return 'COUNT must be >= 1';
  return null;
}

/**
 * Expand raw rule-generated wall times (exceptions applied later).
 * DTSTART is the first occurrence when it matches the BY-pattern
 * (RFC 5545: DTSTART that conforms is part of the set).
 */
export function expandRaw(rrule: RRule, dtstart: string, hardHorizon: string): string[] {
  const start = parseWall(dtstart);
  const horizon = parseWall(hardHorizon);
  const until = rrule.until ? parseWall(rrule.until) : null;
  const out: string[] = [];
  const wantCount = rrule.count ?? Infinity;

  function within(w: Wall): boolean {
    if (compareWall(w, horizon) > 0) return false;
    if (until && compareWall(w, until) > 0) return false;
    return true;
  }

  if (rrule.freq === 'DAILY') {
    let w = start;
    let guard = 0;
    while (compareWall(w, horizon) <= 0 && out.length < wantCount && guard++ < 100000) {
      if (!until || compareWall(w, until) <= 0) out.push(wallKey(w));
      w = addDays(w, rrule.interval);
    }
    return out;
  }

  if (rrule.freq === 'WEEKLY') {
    const days = (rrule.byWeekDay?.length ? rrule.byWeekDay : [weekdayOf(start)]).map((d) => WEEKDAYS.indexOf(d)).sort((a, b) => a - b);
    // Anchor week: ISO week containing DTSTART, Monday-based.
    const anchor = addDays(start, -WEEKDAYS.indexOf(weekdayOf(start)));
    let k = 0;
    let guard = 0;
    while (guard++ < 100000) {
      let produced = false;
      for (const dow of days) {
        const w = addDays(anchor, k * 7 * rrule.interval + dow);
        if (compareWall(w, start) < 0) continue;
        if (compareWall(w, horizon) > 0) return out;
        if (until && compareWall(w, until) > 0) return out;
        out.push(wallKey(w));
        produced = true;
        if (out.length >= wantCount) return out;
      }
      if (!produced && k > 0 && compareWall(addDays(anchor, k * 7 * rrule.interval), horizon) > 0) return out;
      k++;
    }
    return out;
  }

  // MONTHLY: BYMONTHDAY selects dates, plain BYDAY selects all matching
  // weekdays of the month; when both are given they intersect (RFC 5545).
  const monthDays = rrule.byMonthDay && rrule.byMonthDay.length ? rrule.byMonthDay : null;
  const weekdaySet = rrule.byWeekDay && rrule.byWeekDay.length
    ? new Set(rrule.byWeekDay.map((d) => WEEKDAYS.indexOf(d)))
    : null;
  let k = 0;
  let guard = 0;
  while (guard++ < 100000) {
    // Step by calendar month index, never by normalising Jan 31 + 1 month
    // (which would roll into March and double-count it).
    const {y, mo} = addCalendarMonth(start.y, start.mo, k * rrule.interval);
    const dim = daysInMonth(y, mo);
    const candidates: Wall[] = [];
    for (let d = 1; d <= dim; d++) {
      const w: Wall = {y, mo, d, h: start.h, mi: start.mi, s: start.s};
      // With no BY-parts the rule keeps the start day-of-month. An invalid date
      // (e.g. BYMONTHDAY=31 in February) is skipped, never rolled forward.
      const include = monthDays || weekdaySet
        ? (monthDays
            ? monthDays.some((md) => (md < 0 ? dim + md + 1 : md) === d)
            : true)
          && (weekdaySet
            ? weekdaySet.has(WEEKDAYS.indexOf(weekdayOf(w)))
            : true)
        : d === start.d;
      if (include) candidates.push(w);
    }
    candidates.sort(compareWall);
    for (const c of candidates) {
      if (compareWall(c, start) < 0) continue;
      if (!within(c)) return out;
      out.push(wallKey(c));
      if (out.length >= wantCount) return out;
    }
    k++;
    const probe: Wall = {y, mo, d: 1, h: start.h, mi: start.mi, s: start.s};
    if (compareWall(probe, horizon) > 0 && !until) return out;
    if (until && compareWall(probe, until) > 0) return out;
  }
  return out;
}

/** Strictly-latest wall time a bounded rule can generate. */
function boundedEnd(rrule: RRule, dtstart: string): string | null {
  const start = parseWall(dtstart);
  if (rrule.until) return rrule.until;
  if (rrule.count) {
    const all = expandRaw(rrule, dtstart, wallKey(addMonths(start, 1200)));
    return all[all.length - 1] ?? null;
  }
  return null;
}

/** The wall time at which a following segment starts (one second past last generated). */
export function splitBoundary(rrule: RRule, dtstart: string): string | null {
  const end = boundedEnd(rrule, dtstart);
  return end ? wallKey(previousSecond(parseWall(end))) : null;
}

/**
 * Expand a segment, remapping inherited occurrences into local coordinates
 * (the new segment takes ownership of every exception whose ORIGINAL identity
 * falls in its span).
 */
export function expandRule(rule: Rule, hardHorizon: string): Occurrence[] {
  const raw = expandRaw(rule.rrule, rule.dtstart, hardHorizon);
  const byId = new Map(rule.exceptions.map((e) => [e.recurrenceId, e]));
  return raw.map((key) => {
    const ex = byId.get(key);
    if (!ex) return { uid: `${rule.id}:${key}`, ruleId: rule.id, start: key, effectiveStart: key, status: 'ok' as const };
    if (!ex.replacement) {
      return { uid: `${rule.id}:${key}`, ruleId: rule.id, start: key, effectiveStart: key, status: 'cancelled' as const };
    }
    return { uid: `${rule.id}:${key}`, ruleId: rule.id, start: key, effectiveStart: ex.replacement, status: 'moved' as const };
  });
}

/** Expand the whole chain; later segments override earlier ones at the same wall time. */
export function expandSeries(series: Series, hardHorizon: string): Occurrence[] {
  const byStart = new Map<string, Occurrence>();
  for (const rule of [...series.rules].sort((a, b) => a.seq - b.seq)) {
    for (const occ of expandRule(rule, hardHorizon)) {
      byStart.set(occ.start, occ);
    }
  }
  return [...byStart.values()].sort((a, b) => compareWall(parseWall(a.start), parseWall(b.start)));
}

/** Does this segment generate an occurrence at exactly `key`? */
export function segmentGenerates(rule: Rule, key: string, hardHorizon: string): boolean {
  return expandRaw(rule.rrule, rule.dtstart, hardHorizon).includes(key);
}

export function findSegment(series: Series, key: string, hardHorizon: string): Rule | null {
  for (const rule of [...series.rules].sort((a, b) => b.seq - a.seq)) {
    if (segmentGenerates(rule, key, hardHorizon)) return rule;
  }
  return null;
}
