import {describe,expect,it} from 'vitest';
import {
  applyInverse,
  applyMove,
  expandOccurrences,
  listOccurrences,
  localPartsToUtc,
  parseLocal,
  MoveError,
  type OccurrenceException,
  type Rule,
  type Store,
} from '../src/shared/recurrence';

function rule(partial: Partial<Rule> & {id: string}): Rule {
  return {
    title: partial.id,
    tz: 'UTC',
    startLocal: '2026-01-01T09:00',
    durationMin: 30,
    revision: 1,
    rrule: {freq: 'DAILY', interval: 1},
    ...partial,
  };
}
function storeOf(r: Rule, exceptions: OccurrenceException[] = []): Store {
  return {rules: [r], exceptions};
}
function at(r: Rule, index: number): string {
  return listOccurrences(r)[index].utc;
}
function isoPlus(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
}
/** Compare stores ignoring revision counters (undo bumps them by design). */
function normalized(s: Store) {
  return {
    rules: s.rules.map((r) => ({...r, revision: 0})).sort((a, b) => a.id.localeCompare(b.id)),
    exceptions: s.exceptions.slice().sort((a, b) => a.id.localeCompare(b.id)),
  };
}

describe('expansion', () => {
  it('skips invalid month days (Feb 31 etc.) instead of clamping', () => {
    const r = rule({id: 'r', startLocal: '2026-01-31T10:00', rrule: {freq: 'MONTHLY', interval: 1, byMonthDay: [31]}});
    expect(listOccurrences(r).slice(0, 6).map((o) => o.local)).toEqual([
      '2026-01-31T10:00',
      '2026-03-31T10:00',
      '2026-05-31T10:00',
      '2026-07-31T10:00',
      '2026-08-31T10:00',
      '2026-10-31T10:00',
    ]);
  });

  it('COUNT counts only valid month days', () => {
    const r = rule({id: 'r', startLocal: '2026-01-31T10:00', rrule: {freq: 'MONTHLY', interval: 1, byMonthDay: [31], count: 3}});
    expect(listOccurrences(r).map((o) => o.local)).toEqual([
      '2026-01-31T10:00',
      '2026-03-31T10:00',
      '2026-05-31T10:00',
    ]);
  });

  it('keeps wall clock across the DST spring-forward boundary', () => {
    const r = rule({id: 'r', tz: 'America/New_York', startLocal: '2026-03-06T09:00', rrule: {freq: 'DAILY', interval: 1, count: 4}});
    expect(listOccurrences(r).map((o) => o.utc)).toEqual([
      '2026-03-06T14:00:00.000Z', // EST  UTC-5
      '2026-03-07T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z', // EDT  UTC-4
      '2026-03-09T13:00:00.000Z',
    ]);
  });
});

describe('move scope=single (例外记录，不展开序列)', () => {
  it('appends one modified exception keyed by the original occurrence identity', () => {
    const r = rule({id: 'r', rrule: {freq: 'DAILY', interval: 1, count: 5}});
    const s = storeOf(r);
    const target = at(r, 2);
    const result = applyMove(s, {ruleId: 'r', originalStart: target, newStart: isoPlus(target, 2), scope: 'single'});
    expect(s.rules).toHaveLength(1); // 序列没有展开成独立记录
    expect(s.exceptions).toHaveLength(1);
    expect(s.exceptions[0]).toMatchObject({ruleId: 'r', originalStart: target, kind: 'modified', newStart: isoPlus(target, 2)});
    const expanded = expandOccurrences(r, s.exceptions, 0, Date.parse('2027-01-01'));
    expect(expanded.find((o) => o.id === target)).toMatchObject({modified: true, start: isoPlus(target, 2)});
    // 逆操作是结构化的一条记录，而非整个集合的快照
    expect(result.inverse).toEqual([{op: 'removeException', exceptionId: s.exceptions[0].id, ruleId: 'r'}]);
  });

  it('re-dragging an already moved occurrence updates the same delta record', () => {
    const r = rule({id: 'r', rrule: {freq: 'DAILY', interval: 1, count: 5}});
    const s = storeOf(r);
    const target = at(r, 2);
    const before = structuredClone(s);
    const first = applyMove(s, {ruleId: 'r', originalStart: target, newStart: isoPlus(target, 2), scope: 'single'});
    const second = applyMove(s, {ruleId: 'r', originalStart: target, newStart: isoPlus(target, 5), scope: 'single'});
    expect(s.exceptions).toHaveLength(1);
    expect(second.changes.updatedException?.after.newStart).toBe(isoPlus(target, 5));
    // 两级撤销：先回到第一次移动，再恢复原状
    applyInverse(s, second.inverse);
    expect(s.exceptions[0].newStart).toBe(isoPlus(target, 2));
    applyInverse(s, first.inverse);
    expect(normalized(s)).toEqual(normalized(before));
  });

  it('undo restores rules and exceptions via structured inverse ops', () => {
    const r = rule({id: 'r', rrule: {freq: 'DAILY', interval: 1, count: 5}});
    const s = storeOf(r);
    const before = structuredClone(s);
    const result = applyMove(s, {ruleId: 'r', originalStart: at(r, 1), newStart: '2026-01-02T20:00:00.000Z', scope: 'single'});
    applyInverse(s, result.inverse);
    expect(normalized(s)).toEqual(normalized(before));
  });
});

describe('move scope=following (截断 + 新规则 + 例外迁移)', () => {
  it('splits a COUNT rule, preserving the total number of occurrences', () => {
    const r = rule({id: 'r', rrule: {freq: 'DAILY', interval: 1, count: 10}});
    const s = storeOf(r);
    const drop = '2026-01-05T15:00:00.000Z';
    applyMove(s, {ruleId: 'r', originalStart: at(r, 4), newStart: drop, scope: 'following'});
    expect(s.rules).toHaveLength(2);
    expect(r.rrule.count).toBe(4);
    expect(r.rrule.until).toBe('2026-01-04T09:00:00.000Z');
    const succ = s.rules[1];
    expect(succ.rrule.count).toBe(6);
    expect(succ.startLocal).toBe('2026-01-05T15:00');
    expect(listOccurrences(r)).toHaveLength(4);
    expect(listOccurrences(succ)).toHaveLength(6);
    expect(listOccurrences(succ)[0].utc).toBe(drop);
  });

  it('splits an UNTIL rule: original truncated to the previous occurrence, successor keeps UNTIL', () => {
    const r = rule({id: 'r', rrule: {freq: 'DAILY', interval: 1, until: '2026-01-10T09:00:00.000Z'}});
    const s = storeOf(r);
    applyMove(s, {ruleId: 'r', originalStart: at(r, 2), newStart: '2026-01-03T12:00:00.000Z', scope: 'following'});
    expect(r.rrule.until).toBe('2026-01-02T09:00:00.000Z');
    const succ = s.rules[1];
    expect(succ.rrule.until).toBe('2026-01-10T09:00:00.000Z');
    expect(succ.rrule.count).toBeUndefined();
    expect(listOccurrences(r).map((o) => o.local)).toEqual(['2026-01-01T09:00', '2026-01-02T09:00']);
    const succLocals = listOccurrences(succ).map((o) => o.local);
    expect(succLocals[0]).toBe('2026-01-03T12:00');
    expect(succLocals[succLocals.length - 1]).toBe('2026-01-09T12:00'); // 01-10 12:00 超出 UNTIL
  });

  it('re-anchors monthly day selectors on the drop date', () => {
    const r = rule({id: 'r', startLocal: '2026-01-31T10:00', rrule: {freq: 'MONTHLY', interval: 1, byMonthDay: [31]}});
    const s = storeOf(r);
    applyMove(s, {ruleId: 'r', originalStart: at(r, 1), newStart: '2026-03-15T10:00:00.000Z', scope: 'following'});
    expect(listOccurrences(r).map((o) => o.local)).toEqual(['2026-01-31T10:00']);
    const succ = s.rules[1];
    expect(succ.rrule.byMonthDay).toEqual([15]);
    expect(listOccurrences(succ).slice(0, 3).map((o) => o.local)).toEqual([
      '2026-03-15T10:00',
      '2026-04-15T10:00',
      '2026-05-15T10:00',
    ]);
  });

  it('keeps the [31] selector when the drop lands on the 31st (invalid months still skipped)', () => {
    const r = rule({id: 'r', startLocal: '2026-01-31T10:00', rrule: {freq: 'MONTHLY', interval: 1, byMonthDay: [31]}});
    const s = storeOf(r);
    applyMove(s, {ruleId: 'r', originalStart: at(r, 1), newStart: '2026-05-31T10:00:00.000Z', scope: 'following'});
    const succ = s.rules[1];
    expect(succ.rrule.byMonthDay).toEqual([31]);
    expect(listOccurrences(succ).slice(0, 3).map((o) => o.local)).toEqual([
      '2026-05-31T10:00',
      '2026-07-31T10:00', // 6 月无 31 日，跳过
      '2026-08-31T10:00',
    ]);
  });

  it('migrates tail exceptions onto the successor with remapped identities', () => {
    const r = rule({id: 'r', startLocal: '2026-03-01T09:00', rrule: {freq: 'DAILY', interval: 1, count: 8}});
    const occ = listOccurrences(r);
    const exceptions: OccurrenceException[] = [
      {id: 'ex-a', ruleId: 'r', originalStart: occ[1].utc, kind: 'excluded'},
      {id: 'ex-b', ruleId: 'r', originalStart: occ[5].utc, kind: 'modified', newStart: isoPlus(occ[5].utc, 3)},
      {id: 'ex-c', ruleId: 'r', originalStart: occ[6].utc, kind: 'excluded'},
    ];
    const s = storeOf(r, exceptions);
    const before = structuredClone(s);
    const result = applyMove(s, {ruleId: 'r', originalStart: occ[3].utc, newStart: '2026-03-04T20:00:00.000Z', scope: 'following'});
    const succ = s.rules[1];
    // 前半段例外留在原规则
    expect(exceptions.find((e) => e.id === 'ex-a')).toMatchObject({ruleId: 'r', originalStart: occ[1].utc});
    // 后半段例外迁移：旧下标 i → 新下标 i-3，身份重映射到新规则的 occurrence
    expect(exceptions.find((e) => e.id === 'ex-b')).toMatchObject({
      ruleId: succ.id,
      originalStart: '2026-03-06T20:00:00.000Z',
      newStart: isoPlus(occ[5].utc, 3), // 绝对新时间保留
    });
    expect(exceptions.find((e) => e.id === 'ex-c')).toMatchObject({ruleId: succ.id, originalStart: '2026-03-07T20:00:00.000Z'});
    expect(result.changes.migratedExceptions?.map((m) => m.exceptionId).sort()).toEqual(['ex-b', 'ex-c']);
    // 新规则展开后例外生效
    const expanded = expandOccurrences(succ, s.exceptions, 0, Date.parse('2027-01-01'));
    expect(expanded.find((o) => o.id === '2026-03-06T20:00:00.000Z')).toMatchObject({modified: true, start: isoPlus(occ[5].utc, 3)});
    expect(expanded.find((o) => o.id === '2026-03-07T20:00:00.000Z')).toMatchObject({excluded: true});
    // 逆操作是结构化增量：逐条例外迁回 + 删新规则 + 恢复原 rrule
    expect(result.inverse.map((op) => op.op)).toEqual(['moveException', 'moveException', 'deleteRule', 'setRRule']);
    applyInverse(s, result.inverse);
    expect(normalized(s)).toEqual(normalized(before));
  });

  it('splits across the DST boundary: successor keeps the new wall clock', () => {
    const r = rule({id: 'r', tz: 'America/New_York', startLocal: '2026-03-06T09:00', rrule: {freq: 'DAILY', interval: 1, count: 5}});
    const s = storeOf(r);
    const occ = listOccurrences(r);
    const dropUtc = new Date(localPartsToUtc(parseLocal('2026-03-08T10:30'), 'America/New_York')).toISOString();
    applyMove(s, {ruleId: 'r', originalStart: occ[2].utc, newStart: dropUtc, scope: 'following'});
    const succ = s.rules[1];
    expect(succ.startLocal).toBe('2026-03-08T10:30');
    expect(listOccurrences(succ).map((o) => o.utc)).toEqual([
      '2026-03-08T14:30:00.000Z', // EDT
      '2026-03-09T14:30:00.000Z',
      '2026-03-10T14:30:00.000Z',
    ]);
    expect(listOccurrences(r).map((o) => o.utc)).toEqual([
      '2026-03-06T14:00:00.000Z', // EST
      '2026-03-07T14:00:00.000Z',
    ]);
  });

  it('single-move across the DST boundary maps the drop wall clock to the right instant', () => {
    const r = rule({id: 'r', tz: 'America/New_York', startLocal: '2026-03-06T09:00', rrule: {freq: 'DAILY', interval: 1, count: 4}});
    const s = storeOf(r);
    const occ = listOccurrences(r);
    const dropUtc = new Date(localPartsToUtc(parseLocal('2026-03-09T09:00'), 'America/New_York')).toISOString();
    expect(dropUtc).toBe('2026-03-09T13:00:00.000Z'); // 09:00 EDT，而非 14:00Z
    applyMove(s, {ruleId: 'r', originalStart: occ[0].utc, newStart: dropUtc, scope: 'single'});
    expect(s.exceptions[0]).toMatchObject({
      kind: 'modified',
      originalStart: '2026-03-06T14:00:00.000Z',
      newStart: '2026-03-09T13:00:00.000Z',
    });
  });

  it('supports two consecutive this-and-following edits, then undoes both', () => {
    const r = rule({id: 'r', startLocal: '2026-04-01T09:00', rrule: {freq: 'DAILY', interval: 1, count: 12}});
    const occ = listOccurrences(r);
    const exceptions: OccurrenceException[] = [{id: 'ex-x', ruleId: 'r', originalStart: occ[7].utc, kind: 'excluded'}];
    const s = storeOf(r, exceptions);

    // 第一次：在下标 5 处截断 → 5 + 7
    const first = applyMove(s, {ruleId: 'r', originalStart: occ[5].utc, newStart: '2026-04-06T18:00:00.000Z', scope: 'following'});
    const r2 = s.rules.find((x) => x.id !== 'r')!;
    expect(r.rrule.count).toBe(5);
    expect(r2.rrule.count).toBe(7);
    // 例外随后半段迁移：旧下标 7 → 新下标 2
    expect(exceptions[0]).toMatchObject({ruleId: r2.id, originalStart: '2026-04-08T18:00:00.000Z'});

    // 第二次：在新规则的下标 3 处再次截断 → 3 + 4
    const second = applyMove(s, {ruleId: r2.id, originalStart: '2026-04-09T18:00:00.000Z', newStart: '2026-04-09T23:00:00.000Z', scope: 'following'});
    const r3 = s.rules[2];
    expect(r2.rrule.count).toBe(3);
    expect(r3.rrule.count).toBe(4);
    expect(r3.startLocal).toBe('2026-04-09T23:00');
    // 例外位于前半段（下标 2 < 3），留在 r2
    expect(exceptions[0]).toMatchObject({ruleId: r2.id, originalStart: '2026-04-08T18:00:00.000Z'});
    expect(listOccurrences(r)).toHaveLength(5);
    expect(listOccurrences(r2)).toHaveLength(3);
    expect(listOccurrences(r3)).toHaveLength(4);

    // 逆序撤销两次，序列与例外完全还原
    applyInverse(s, second.inverse);
    applyInverse(s, first.inverse);
    expect(s.rules.map((x) => x.id)).toEqual(['r']);
    expect(r.rrule).toEqual({freq: 'DAILY', interval: 1, count: 12});
    expect(exceptions[0]).toMatchObject({ruleId: 'r', originalStart: occ[7].utc});
  });

  it('rejects splitting at the first occurrence and dragging excluded ones', () => {
    const r = rule({id: 'r', rrule: {freq: 'DAILY', interval: 1, count: 5}});
    const occ = listOccurrences(r);
    const s = storeOf(r, [{id: 'ex-1', ruleId: 'r', originalStart: occ[1].utc, kind: 'excluded'}]);
    expect(() => applyMove(s, {ruleId: 'r', originalStart: occ[0].utc, newStart: occ[0].utc, scope: 'following'})).toThrowError(MoveError);
    expect(() => applyMove(s, {ruleId: 'r', originalStart: occ[1].utc, newStart: occ[2].utc, scope: 'single'})).toThrowError(MoveError);
    expect(s.rules).toHaveLength(1); // 失败的操作不留副作用
    expect(s.exceptions).toHaveLength(1);
  });
});
