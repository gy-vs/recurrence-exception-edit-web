import {Exception, Rule, Series, expandRaw, segmentGenerates} from './model';
import {addSeconds, parseWall, wallKey} from './wall';

type PrevBound = {kind: 'count'; count: number} | {kind: 'until'; until: string} | {kind: 'unbounded'};

/**
 * Structured mutations. Undo replays the inverse of each operation — each op
 * carries only the fields it changed (plus the small amount of prior state
 * needed to reverse that field), never a snapshot of the whole rule set.
 */
export type Operation =
  | {
      type: 'exceptionUpsert';
      ruleId: string;
      next: Exception;
      /** Prior exception for the same recurrence id, if one existed. */
      prev: Exception | null;
    }
  | {
      type: 'exceptionDelete';
      ruleId: string;
      prev: Exception;
    }
  | {
      type: 'truncateRule';
      ruleId: string;
      nextBound: PrevBound;
      prevBound: PrevBound;
    }
  | {type: 'ruleAdd'; rule: Rule}
  | {type: 'ruleRemove'; rule: Rule}
  | {type: 'exceptionMove'; fromRuleId: string; toRuleId: string; exception: Exception};

export type Change = {
  /** Human label, e.g. "Move this and following". */
  label: string;
  ops: Operation[];
};

export function cloneSeries(series: Series): Series {
  return structuredClone(series);
}

function getRule(series: Series, id: string): Rule {
  const rule = series.rules.find((r) => r.id === id);
  if (!rule) throw new Error(`unknown rule ${id}`);
  return rule;
}

export function invert(op: Operation): Operation {
  switch (op.type) {
    case 'exceptionUpsert':
      return op.prev
        ? {type: 'exceptionUpsert', ruleId: op.ruleId, next: op.prev, prev: op.next}
        : {type: 'exceptionDelete', ruleId: op.ruleId, prev: op.next};
    case 'exceptionDelete':
      return {type: 'exceptionUpsert', ruleId: op.ruleId, next: op.prev, prev: null};
    case 'truncateRule':
      return {type: 'truncateRule', ruleId: op.ruleId, nextBound: op.prevBound, prevBound: op.nextBound};
    case 'ruleAdd':
      return {type: 'ruleRemove', rule: op.rule};
    case 'ruleRemove':
      return {type: 'ruleAdd', rule: op.rule};
    case 'exceptionMove':
      return {type: 'exceptionMove', fromRuleId: op.toRuleId, toRuleId: op.fromRuleId, exception: op.exception};
  }
}

export function invertChange(change: Change): Change {
  return {
    label: `Undo: ${change.label}`,
    // Inverse order matters: ops are recorded in execution order.
    ops: change.ops.map(invert).reverse(),
  };
}

export function applyOperation(series: Series, op: Operation): void {
  switch (op.type) {
    case 'exceptionUpsert': {
      const rule = getRule(series, op.ruleId);
      const i = rule.exceptions.findIndex((e) => e.recurrenceId === op.next.recurrenceId);
      if (i >= 0) rule.exceptions[i] = structuredClone(op.next);
      else rule.exceptions.push(structuredClone(op.next));
      return;
    }
    case 'exceptionDelete': {
      const rule = getRule(series, op.ruleId);
      rule.exceptions = rule.exceptions.filter((e) => e.recurrenceId !== op.prev.recurrenceId);
      return;
    }
    case 'truncateRule': {
      const rule = getRule(series, op.ruleId);
      delete rule.rrule.count;
      delete rule.rrule.until;
      if (op.nextBound.kind === 'count') rule.rrule.count = op.nextBound.count;
      if (op.nextBound.kind === 'until') rule.rrule.until = op.nextBound.until;
      return;
    }
    case 'ruleAdd': {
      if (series.rules.some((r) => r.id === op.rule.id)) throw new Error(`duplicate rule ${op.rule.id}`);
      series.rules.push(structuredClone(op.rule));
      series.rules.sort((a, b) => a.seq - b.seq);
      return;
    }
    case 'ruleRemove': {
      series.rules = series.rules.filter((r) => r.id !== op.rule.id);
      return;
    }
    case 'exceptionMove': {
      const from = getRule(series, op.fromRuleId);
      const to = getRule(series, op.toRuleId);
      from.exceptions = from.exceptions.filter((e) => e.recurrenceId !== op.exception.recurrenceId);
      if (!to.exceptions.some((e) => e.recurrenceId === op.exception.recurrenceId)) {
        to.exceptions.push(structuredClone(op.exception));
      }
      return;
    }
  }
}

/** Apply a change locally (used for optimistic preview and undo replay). */
export function applyChange(series: Series, change: Change): void {
  for (const op of change.ops) applyOperation(series, op);
}

// --- change construction ---------------------------------------------------

export type DragScope = 'this' | 'thisAndFuture';

export type DragRequest = {
  /** Rule segment containing the dragged occurrence. */
  ruleId: string;
  /** Original wall time that was dragged (its identity). */
  recurrenceId: string;
  /** New wall time; equal to recurrenceId => cancellation toggle uses replace=undefined. */
  newStart?: string;
  cancel?: boolean;
  scope: DragScope;
  zone: string;
};

const PREVIEW_HORIZON_MONTHS = 1200;

export function previewHorizon(fromKey: string): string {
  const w = parseWall(fromKey);
  const y = w.y + Math.floor(PREVIEW_HORIZON_MONTHS / 12) + 2;
  return wallKey({y, mo: 1, d: 1, h: 23, mi: 59, s: 59});
}

/**
 * Build the structured change for a drag.
 * - scope "this": one exception on the generating segment (EXDATE or RECURRENCE-ID override).
 * - scope "thisAndFuture": truncate the segment one second before the dragged
 *   occurrence, add a new segment starting at the dragged key, and migrate every
 *   existing exception at/after the boundary into the new segment.
 */
export function buildDragChange(series: Series, req: DragRequest): Change {
  const rule = getRule(series, req.ruleId);
  if (!segmentGenerates(rule, req.recurrenceId, req.recurrenceId)) {
    throw new Error(`rule ${rule.id} does not generate ${req.recurrenceId}`);
  }
  const key = req.recurrenceId;

  if (req.scope === 'this') {
    const next: Exception = {
      recurrenceId: key,
      ...(req.cancel ? {} : {replacement: req.newStart ?? key}),
    };
    const prev = rule.exceptions.find((e) => e.recurrenceId === key) ?? null;
    const ops: Operation[] = [];
    if (req.cancel && prev) {
      // Already an exception: dropping it restores the plain occurrence.
      ops.push({type: 'exceptionDelete', ruleId: rule.id, prev});
    } else {
      // Plain occurrence -> EXDATE; or one override replaced by another.
      ops.push({type: 'exceptionUpsert', ruleId: rule.id, next, prev});
    }
    return {label: req.cancel ? 'Cancel this occurrence' : 'Edit this occurrence', ops};
  }

  // thisAndFuture -----------------------------------------------------------
  const ops: Operation[] = [];
  const lastKept = wallKey(addSeconds(parseWall(key), -1));

  const prevBound: PrevBound =
    rule.rrule.count !== undefined
      ? {kind: 'count', count: rule.rrule.count}
      : rule.rrule.until
        ? {kind: 'until', until: rule.rrule.until}
        : {kind: 'unbounded'};

  ops.push({type: 'truncateRule', ruleId: rule.id, nextBound: {kind: 'until', until: lastKept}, prevBound});

  // The new segment inherits the number of occurrences at/after the split
  // (COUNT) or the original UNTIL; the split itself carries the bound.
  const newRrule = structuredClone(rule.rrule);
  if (newRrule.count !== undefined) {
    // Only COUNT rules need the tail enumerated; unbounded/UNTIL rules stop at
    // their bound or the horizon without producing a usable remainder count.
    const tailCount = expandRaw(rule.rrule, rule.dtstart, previewHorizon(rule.dtstart))
      .filter((k) => k >= key).length;
    newRrule.count = tailCount;
  }
  if (rule.rrule.until) newRrule.until = rule.rrule.until;

  const nextSeq = series.rules.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
  const newRule: Rule = {
    id: `${series.id}-seg${nextSeq}`,
    seq: nextSeq,
    rrule: newRrule,
    // DTSTART anchors the sequence at the dragged occurrence's original wall
    // time so "following" keys stay identical; the move rides as one exception.
    dtstart: key,
    zone: req.zone,
    exceptions: [],
  };
  ops.push({type: 'ruleAdd', rule: newRule});

  // Existing exceptions belonging to occurrences at/after the split migrate
  // with the segment that owns them. Wall keys are stable across the split
  // (same time of day, same zone), so they move with keys unchanged.
  for (const ex of rule.exceptions) {
    if (ex.recurrenceId >= key) {
      ops.push({type: 'exceptionMove', fromRuleId: rule.id, toRuleId: newRule.id, exception: structuredClone(ex)});
    }
  }

  // The dragged occurrence itself. If it already carried an exception it was
  // migrated above; the upsert replaces it and the inverse restores it.
  const draggedPrev = rule.exceptions.find((e) => e.recurrenceId === key) ?? null;
  if (req.cancel) {
    ops.push({type: 'exceptionUpsert', ruleId: newRule.id, next: {recurrenceId: key}, prev: draggedPrev});
  } else if (req.newStart && req.newStart !== key) {
    ops.push({
      type: 'exceptionUpsert',
      ruleId: newRule.id,
      next: {recurrenceId: key, replacement: req.newStart},
      prev: draggedPrev,
    });
  }

  return {label: 'Split and move from here', ops};
}

/**
 * Re-anchor a pending change onto a newer revision after a 409: rebuild the
 * drag against the fresh series. The drag *intent* (which occurrence, where
 * to, which scope) survives; stale ids are resolved against current segments.
 */
export function rebaseIntent(series: Series, intent: DragRequest): Change {
  // Re-resolve the owning segment for the same occurrence identity.
  let ownerId = intent.ruleId;
  if (!series.rules.some((r) => r.id === ownerId && segmentGenerates(r, intent.recurrenceId, intent.recurrenceId))) {
    const owner = [...series.rules].sort((a, b) => b.seq - a.seq)
      .find((r) => segmentGenerates(r, intent.recurrenceId, intent.recurrenceId));
    if (!owner) throw new Error('occurrence no longer exists on current revision');
    ownerId = owner.id;
  }
  return buildDragChange(series, {...intent, ruleId: ownerId});
}
