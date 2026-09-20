/**
 * Recurrence engine + exception-aware editing operations.
 *
 * Model
 * -----
 * A `Rule` generates occurrences from a wall-clock `startLocal` in an IANA
 * timezone (`tz`). Occurrences keep their local wall time across DST
 * transitions; only their UTC instants shift.
 *
 * An `OccurrenceException` is a delta record keyed by the *identity* of an
 * occurrence — the UTC instant the occurrence would have started at in its
 * rule. Exceptions never expand the series into standalone records:
 *   - kind 'excluded'  → the occurrence is suppressed (EXDATE equivalent)
 *   - kind 'modified'  → the occurrence is moved to `newStart` (a replacement
 *     that still references the original occurrence identity)
 *
 * "Move this occurrence"        → append one 'modified' exception.
 * "Move this and following"     → truncate the original rule (COUNT/UNTIL),
 *                                 create a successor rule starting at the drop
 *                                 instant, and migrate the tail exceptions
 *                                 onto the successor with remapped identities.
 *
 * Every mutation returns a list of structured `InverseOp`s so it can be
 * undone without snapshotting the whole collection.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type WeekDay = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface RRuleSpec {
  freq: Freq;
  interval: number; // >= 1
  byWeekDay?: WeekDay[]; // WEEKLY
  byMonthDay?: number[]; // MONTHLY
  count?: number;
  until?: string; // UTC ISO instant, inclusive
}

export interface Rule {
  id: string;
  title: string;
  tz: string; // IANA name
  startLocal: string; // 'YYYY-MM-DDTHH:mm' wall clock of the first occurrence
  durationMin: number;
  rrule: RRuleSpec;
  revision: number;
}

export type ExceptionKind = 'excluded' | 'modified';

export interface OccurrenceException {
  id: string;
  ruleId: string;
  /** Identity: UTC ISO instant of the original occurrence in its rule. */
  originalStart: string;
  kind: ExceptionKind;
  /** kind === 'modified': absolute UTC ISO instant the occurrence moves to. */
  newStart?: string;
  newDurationMin?: number;
}

export interface Store {
  rules: Rule[];
  exceptions: OccurrenceException[];
}

export interface Occurrence {
  index: number;
  /** Identity of this occurrence: UTC ISO instant per the rule, unmodified. */
  utc: string;
  /** Wall-clock local time 'YYYY-MM-DDTHH:mm' in the rule's tz. */
  local: string;
}

export interface ExpandedOccurrence {
  /** Stable identity (original UTC ISO instant). */
  id: string;
  index: number;
  /** Actual start (UTC ISO) — equals id unless a 'modified' exception moved it. */
  start: string;
  originalStart: string;
  local: string;
  excluded: boolean;
  modified: boolean;
  durationMin: number;
}

// ---------------------------------------------------------------------------
// Local wall-clock <-> UTC conversion (IANA tz via Intl)
// ---------------------------------------------------------------------------

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let fmt = dtfCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, fmt);
  }
  return fmt;
}

export function utcToLocalParts(utcMs: number, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const take = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl part missing: ${type}`);
    return Number(part.value);
  };
  return {
    year: take('year'),
    month: take('month'),
    day: take('day'),
    hour: take('hour') % 24,
    minute: take('minute'),
    second: take('second'),
  };
}

function partsAsUtcMs(p: LocalParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/**
 * Convert wall-clock parts in `tz` to a UTC instant (ms).
 * Iterates the fixed-point offset; for nonexistent wall times (DST gap) it
 * settles on the closest valid instant, for ambiguous ones (DST overlap) on
 * the first occurrence.
 */
export function localPartsToUtc(p: LocalParts, tz: string): number {
  const target = partsAsUtcMs(p);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const actual = utcToLocalParts(guess, tz);
    const diff = target - partsAsUtcMs(actual);
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
}

export function parseLocal(s: string): LocalParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw new Error(`invalid local time: ${s}`);
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] ? Number(m[6]) : 0,
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function formatLocal(p: LocalParts): string {
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

function addDays(p: LocalParts, days: number): LocalParts {
  const d = new Date(partsAsUtcMs(p) + days * 86_400_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

function compareLocal(a: LocalParts, b: LocalParts): number {
  return partsAsUtcMs(a) - partsAsUtcMs(b);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const WEEKDAY_ORDER: WeekDay[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export function weekDayOf(p: LocalParts): WeekDay {
  const jsDay = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return WEEKDAY_ORDER[(jsDay + 6) % 7];
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

const HARD_CAP = 5000;

/**
 * Lazily generate the occurrences of a rule, in order, keeping wall-clock
 * time in the rule's timezone. Invalid month days (e.g. Feb 31) are skipped
 * and never counted towards COUNT.
 */
export function* iterateOccurrences(rule: Rule, cap = HARD_CAP): Generator<Occurrence> {
  const start = parseLocal(rule.startLocal);
  const interval = Math.max(1, rule.rrule.interval || 1);
  const untilMs = rule.rrule.until ? Date.parse(rule.rrule.until) : Number.POSITIVE_INFINITY;
  const limit = rule.rrule.count ?? Number.POSITIVE_INFINITY;
  let index = 0;
  let emitted = 0;

  const emit = function* (candidate: LocalParts): Generator<Occurrence, boolean> {
    const utcMs = localPartsToUtc(candidate, rule.tz);
    if (utcMs > untilMs) return true; // signal: stop
    if (index >= limit) return true;
    yield { index, utc: new Date(utcMs).toISOString(), local: formatLocal(candidate) };
    index += 1;
    emitted += 1;
    return false;
  };

  if (rule.rrule.freq === 'DAILY') {
    for (let k = 0; emitted < cap; k += 1) {
      const stop = yield* emit(addDays(start, k * interval));
      if (stop) return;
    }
    return;
  }

  if (rule.rrule.freq === 'WEEKLY') {
    const days = (rule.rrule.byWeekDay?.length ? rule.rrule.byWeekDay : [weekDayOf(start)])
      .slice()
      .sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b));
    const weekStart = addDays(start, -WEEKDAY_ORDER.indexOf(weekDayOf(start)));
    for (let w = 0; emitted < cap; w += 1) {
      for (const day of days) {
        const candidate = addDays(weekStart, w * 7 * interval + WEEKDAY_ORDER.indexOf(day));
        if (compareLocal(candidate, start) < 0) continue;
        const stop = yield* emit(candidate);
        if (stop) return;
      }
    }
    return;
  }

  // MONTHLY
  const monthDays = (rule.rrule.byMonthDay?.length ? rule.rrule.byMonthDay : [start.day])
    .slice()
    .sort((a, b) => a - b);
  for (let m = 0; emitted < cap; m += 1) {
    const total = start.year * 12 + (start.month - 1) + m * interval;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    const dim = daysInMonth(year, month);
    for (const md of monthDays) {
      if (md < 1 || md > dim) continue; // invalid date for this month: skip
      const candidate: LocalParts = {
        year,
        month,
        day: md,
        hour: start.hour,
        minute: start.minute,
        second: start.second,
      };
      if (compareLocal(candidate, start) < 0) continue;
      const stop = yield* emit(candidate);
      if (stop) return;
    }
  }
}

export function listOccurrences(rule: Rule, cap = HARD_CAP): Occurrence[] {
  return [...iterateOccurrences(rule, cap)];
}

export function findOccurrenceIndex(rule: Rule, utcIso: string): number {
  const target = Date.parse(utcIso);
  for (const occ of iterateOccurrences(rule)) {
    const ms = Date.parse(occ.utc);
    if (ms === target) return occ.index;
    if (ms > target) break;
  }
  return -1;
}

/** Expand a rule with its exceptions applied, for occurrences whose identity
 * falls inside [fromMs, toMs]. Excluded occurrences are kept (flagged) so a
 * timeline can render them as suppressed. */
export function expandOccurrences(
  rule: Rule,
  exceptions: OccurrenceException[],
  fromMs: number,
  toMs: number,
): ExpandedOccurrence[] {
  const byIdentity = new Map<string, OccurrenceException>();
  for (const ex of exceptions) {
    if (ex.ruleId === rule.id) byIdentity.set(ex.originalStart, ex);
  }
  const out: ExpandedOccurrence[] = [];
  for (const occ of iterateOccurrences(rule)) {
    const ms = Date.parse(occ.utc);
    if (ms > toMs) break;
    if (ms < fromMs) continue;
    const ex = byIdentity.get(occ.utc);
    out.push({
      id: occ.utc,
      index: occ.index,
      originalStart: occ.utc,
      start: ex?.kind === 'modified' && ex.newStart ? ex.newStart : occ.utc,
      local: occ.local,
      excluded: ex?.kind === 'excluded',
      modified: ex?.kind === 'modified',
      durationMin: ex?.newDurationMin ?? rule.durationMin,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Move operations (single occurrence / this-and-following)
// ---------------------------------------------------------------------------

export type MoveScope = 'single' | 'following';

export interface MoveRequest {
  ruleId: string;
  /** Identity (UTC ISO) of the dragged occurrence. */
  originalStart: string;
  /** Drop target: absolute UTC ISO instant. */
  newStart: string;
  scope: MoveScope;
}

export type InverseOp =
  | { op: 'removeException'; exceptionId: string; ruleId: string }
  | { op: 'restoreException'; exception: OccurrenceException }
  | { op: 'setRRule'; ruleId: string; rrule: RRuleSpec }
  | { op: 'deleteRule'; ruleId: string }
  | { op: 'moveException'; exceptionId: string; ruleId: string; originalStart: string };

export interface ExceptionMigration {
  exceptionId: string;
  from: { ruleId: string; originalStart: string };
  to: { ruleId: string; originalStart: string };
}

export interface ChangeSet {
  scope: MoveScope;
  addedException?: OccurrenceException;
  updatedException?: { before: OccurrenceException; after: OccurrenceException };
  truncatedRule?: { id: string; count?: number; until?: string };
  newRule?: Rule;
  migratedExceptions?: ExceptionMigration[];
}

export interface MoveResult {
  changes: ChangeSet;
  inverse: InverseOp[];
}

export class MoveError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

let idCounter = 0;
export function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireRule(store: Store, ruleId: string): Rule {
  const rule = store.rules.find((r) => r.id === ruleId);
  if (!rule) throw new MoveError('rule_not_found', `no rule ${ruleId}`);
  return rule;
}

function assertDraggable(store: Store, rule: Rule, originalStart: string): number {
  const index = findOccurrenceIndex(rule, originalStart);
  if (index < 0) {
    throw new MoveError('occurrence_not_found', `${originalStart} is not an occurrence of ${rule.id}`);
  }
  const ex = store.exceptions.find((e) => e.ruleId === rule.id && e.originalStart === originalStart);
  if (ex?.kind === 'excluded') {
    throw new MoveError('occurrence_excluded', 'cannot drag an excluded occurrence');
  }
  return index;
}

/**
 * Apply a drag move to the store (mutates it) and return the changes plus
 * the structured inverse operations needed to undo them.
 */
export function applyMove(store: Store, req: MoveRequest): MoveResult {
  const rule = requireRule(store, req.ruleId);
  const index = assertDraggable(store, rule, req.originalStart);
  if (req.scope === 'single') return moveSingle(store, rule, req);
  return moveFollowing(store, rule, req, index);
}

function moveSingle(store: Store, rule: Rule, req: MoveRequest): MoveResult {
  const existing = store.exceptions.find(
    (e) => e.ruleId === rule.id && e.originalStart === req.originalStart,
  );
  if (existing && existing.kind === 'modified') {
    // Re-dragging an already moved occurrence: update the same delta record.
    const before = clone(existing);
    existing.newStart = req.newStart;
    rule.revision += 1;
    return {
      changes: { scope: 'single', updatedException: { before, after: clone(existing) } },
      inverse: [{ op: 'restoreException', exception: before }],
    };
  }
  const exception: OccurrenceException = {
    id: genId('ex'),
    ruleId: rule.id,
    originalStart: req.originalStart,
    kind: 'modified',
    newStart: req.newStart,
  };
  store.exceptions.push(exception);
  rule.revision += 1;
  return {
    changes: { scope: 'single', addedException: clone(exception) },
    inverse: [{ op: 'removeException', exceptionId: exception.id, ruleId: rule.id }],
  };
}

function moveFollowing(store: Store, rule: Rule, req: MoveRequest, splitIndex: number): MoveResult {
  if (splitIndex === 0) {
    throw new MoveError('cannot_split_first', 'cannot split the series at its first occurrence');
  }
  // Capture the full expansion BEFORE truncating: tail-exception identities
  // are defined in terms of the untruncated rule.
  const full = listOccurrences(rule);
  const splitUtc = req.originalStart;
  const previousUtc = full[splitIndex - 1].utc;
  const oldRRule = clone(rule.rrule);

  // 1. Truncate the original rule so it ends at the occurrence before the split.
  rule.rrule.until = previousUtc;
  if (oldRRule.count != null) rule.rrule.count = splitIndex;
  rule.revision += 1;

  // 2. Successor rule anchored at the drop instant. Day selectors follow the
  //    drop date unless the drop date already matches the original pattern.
  const dropLocal = utcToLocalParts(Date.parse(req.newStart), rule.tz);
  const newRRule: RRuleSpec = {
    freq: oldRRule.freq,
    interval: oldRRule.interval,
    count: oldRRule.count != null ? oldRRule.count - splitIndex : undefined,
    until: oldRRule.until,
  };
  if (oldRRule.freq === 'WEEKLY') {
    const original = oldRRule.byWeekDay?.length ? oldRRule.byWeekDay : [weekDayOf(parseLocal(rule.startLocal))];
    const dropDay = weekDayOf(dropLocal);
    newRRule.byWeekDay = original.includes(dropDay) ? original.slice() : [dropDay];
  }
  if (oldRRule.freq === 'MONTHLY') {
    const original = oldRRule.byMonthDay?.length ? oldRRule.byMonthDay : [parseLocal(rule.startLocal).day];
    newRRule.byMonthDay = original.includes(dropLocal.day) ? original.slice() : [dropLocal.day];
  }
  const successor: Rule = {
    id: genId('rule'),
    title: `${rule.title} (from ${formatLocal(dropLocal)})`,
    tz: rule.tz,
    startLocal: formatLocal(dropLocal),
    durationMin: rule.durationMin,
    rrule: newRRule,
    revision: 1,
  };
  store.rules.push(successor);

  // 3. Migrate tail exceptions (identity >= split instant) onto the successor,
  //    remapping each identity by occurrence index: old index i -> new index
  //    i - splitIndex. 'modified' exceptions keep their absolute newStart.
  const successorOccurrences = listOccurrences(successor);
  const inverse: InverseOp[] = [];
  const migrated: ExceptionMigration[] = [];
  const tail = store.exceptions.filter(
    (e) => e.ruleId === rule.id && Date.parse(e.originalStart) >= Date.parse(splitUtc),
  );
  for (const ex of tail) {
    const oldIndex = full.findIndex((o) => o.utc === ex.originalStart);
    const newIndex = oldIndex - splitIndex;
    const target = newIndex >= 0 ? successorOccurrences[newIndex] : undefined;
    if (oldIndex < 0 || !target) continue; // stale identity: leave untouched
    migrated.push({
      exceptionId: ex.id,
      from: { ruleId: rule.id, originalStart: ex.originalStart },
      to: { ruleId: successor.id, originalStart: target.utc },
    });
    inverse.push({ op: 'moveException', exceptionId: ex.id, ruleId: rule.id, originalStart: ex.originalStart });
    ex.ruleId = successor.id;
    ex.originalStart = target.utc;
  }

  inverse.push({ op: 'deleteRule', ruleId: successor.id });
  inverse.push({ op: 'setRRule', ruleId: rule.id, rrule: oldRRule });

  return {
    changes: {
      scope: 'following',
      truncatedRule: {
        id: rule.id,
        count: rule.rrule.count,
        until: rule.rrule.until,
      },
      newRule: clone(successor),
      migratedExceptions: migrated,
    },
    inverse,
  };
}

/** Apply structured inverse operations (in order) to undo a mutation. */
export function applyInverse(store: Store, inverse: InverseOp[]): void {
  for (const op of inverse) {
    switch (op.op) {
      case 'removeException': {
        store.exceptions = store.exceptions.filter((e) => e.id !== op.exceptionId);
        const rule = store.rules.find((r) => r.id === op.ruleId);
        if (rule) rule.revision += 1;
        break;
      }
      case 'restoreException': {
        const idx = store.exceptions.findIndex((e) => e.id === op.exception.id);
        if (idx >= 0) store.exceptions[idx] = clone(op.exception);
        else store.exceptions.push(clone(op.exception));
        const rule = store.rules.find((r) => r.id === op.exception.ruleId);
        if (rule) rule.revision += 1;
        break;
      }
      case 'setRRule': {
        const rule = store.rules.find((r) => r.id === op.ruleId);
        if (rule) {
          rule.rrule = clone(op.rrule);
          rule.revision += 1;
        }
        break;
      }
      case 'deleteRule': {
        store.rules = store.rules.filter((r) => r.id !== op.ruleId);
        break;
      }
      case 'moveException': {
        const ex = store.exceptions.find((e) => e.id === op.exceptionId);
        if (ex) {
          ex.ruleId = op.ruleId;
          ex.originalStart = op.originalStart;
        }
        const rule = store.rules.find((r) => r.id === op.ruleId);
        if (rule) rule.revision += 1;
        break;
      }
    }
  }
}
