import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {invertChange} from '../src/shared/operations';

async function getStandup(app: ReturnType<typeof createApp>) {
  const res = await request(app).get('/api/series/standup').expect(200);
  return res.body;
}

describe('series API', () => {
  it('lists series and expands occurrences with DST notes', async () => {
    const app = createApp();
    const list = await request(app).get('/api/series').expect(200);
    expect(list.body.some((s: {id: string}) => s.id === 'standup')).toBe(true);

    const standup = await getStandup(app);
    expect(standup.series.revision).toBe(1);
    expect(standup.occurrences.length).toBeGreaterThan(20);
    // Seeded exceptions survive.
    const moved = standup.occurrences.find((o: {start: string}) => o.start === '20260305T090000');
    expect(moved.status).toBe('moved');
    expect(moved.effectiveStart).toBe('20260305T140000');
    // The daily 09:00 crosses the US spring-forward boundary (Mar 8 2026).
    expect(standup.dst.some((n: {crossesBoundary: boolean; start: string}) => n.crossesBoundary && n.start === '20260308T090000')).toBe(true);
  });

  it('preview predicts without persisting or bumping revision', async () => {
    const app = createApp();
    const before = await getStandup(app);
    const res = await request(app).post('/api/series/standup/preview')
      .send({revision: 1, intent: {ruleId: 'standup-1', recurrenceId: '20260308T090000', newStart: '20260309T110000', scope: 'this', zone: 'America/New_York'}})
      .expect(200);
    expect(res.body.baseRevision).toBe(1);
    expect(res.body.change.ops).toHaveLength(1);
    expect(res.body.occurrences.find((o: {start: string}) => o.start === '20260308T090000').status).toBe('moved');
    const after = await getStandup(app);
    expect(after.series.revision).toBe(before.series.revision);
    expect(after.occurrences.find((o: {start: string}) => o.start === '20260308T090000').status).toBe('ok');
  });

  it('drags one occurrence with EXDATE-style identity and bumps revision', async () => {
    const app = createApp();
    const res = await request(app).post('/api/series/standup/drags')
      .send({revision: 1, intent: {ruleId: 'standup-1', recurrenceId: '20260308T090000', cancel: true, scope: 'this', zone: 'America/New_York'}})
      .expect(200);
    expect(res.body.series.revision).toBe(2);
    const occ = res.body.occurrences.find((o: {start: string}) => o.start === '20260308T090000');
    expect(occ.status).toBe('cancelled');
    // Stored as one exception, not expanded records.
    const rule = res.body.series.rules[0];
    expect(rule.exceptions).toContainEqual({recurrenceId: '20260308T090000'});
  });

  it('thisAndFuture splits, migrates tail exceptions, and returns structured ops', async () => {
    const app = createApp();
    const res = await request(app).post('/api/series/standup/drags')
      .send({revision: 1, intent: {ruleId: 'standup-1', recurrenceId: '20260308T090000', newStart: '20260308T120000', scope: 'thisAndFuture', zone: 'America/New_York'}})
      .expect(200);
    expect(res.body.series.rules).toHaveLength(2);
    const [head, tail] = res.body.series.rules;
    expect(head.rrule.until).toBe('20260308T085959');
    expect(tail.dtstart).toBe('20260308T090000');
    // Pre-existing exceptions: Mar 5 stays on head, Mar 10 migrated to tail.
    expect(head.exceptions.map((e: {recurrenceId: string}) => e.recurrenceId)).toEqual(['20260305T090000']);
    expect(tail.exceptions.some((e: {recurrenceId: string}) => e.recurrenceId === '20260310T090000')).toBe(true);
  });

  it('rejects a stale revision with 409 and returns the current series', async () => {
    const app = createApp();
    await request(app).post('/api/series/standup/drags')
      .send({revision: 1, intent: {ruleId: 'standup-1', recurrenceId: '20260308T090000', cancel: true, scope: 'this', zone: 'America/New_York'}})
      .expect(200);
    const stale = await request(app).post('/api/series/standup/drags')
      .send({revision: 1, intent: {ruleId: 'standup-1', recurrenceId: '20260309T090000', cancel: true, scope: 'this', zone: 'America/New_York'}})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.current.series.revision).toBe(2);
  });

  it('preserves drag intent across the conflict and re-applies on the new revision', async () => {
    const app = createApp();
    // Concurrent writer bumps rev 1 -> 2.
    await request(app).post('/api/series/standup/touch').send({}).expect(200);
    // Client retries the same intent against revision 2; it must now succeed.
    const res = await request(app).post('/api/series/standup/drags')
      .send({revision: 2, intent: {ruleId: 'standup-1', recurrenceId: '20260308T090000', newStart: '20260309T110000', scope: 'this', zone: 'America/New_York'}})
      .expect(200);
    expect(res.body.series.revision).toBe(3);
    expect(res.body.occurrences.find((o: {start: string}) => o.start === '20260308T090000').status).toBe('moved');
  });

  it('undo sends structured inverse ops (no whole-collection replace)', async () => {
    const app = createApp();
    const drag = await request(app).post('/api/series/standup/drags')
      .send({revision: 1, intent: {ruleId: 'standup-1', recurrenceId: '20260308T090000', newStart: '20260309T110000', scope: 'thisAndFuture', zone: 'America/New_York'}})
      .expect(200);
    const change = drag.body.appliedChange;
    expect(change.ops.length).toBeGreaterThan(1);
    const inverse = invertChange(change);
    const undone = await request(app).post('/api/series/standup/changes')
      .send({revision: 2, change: inverse})
      .expect(200);
    expect(undone.body.series.revision).toBe(3);
    expect(undone.body.series.rules).toHaveLength(1);
    expect(undone.body.series.rules[0].rrule.until).toBeUndefined();
    const restored = undone.body.occurrences.find((o: {start: string}) => o.start === '20260308T090000');
    expect(restored.status).toBe('ok');
  });

  it('undo itself goes through optimistic concurrency', async () => {
    const app = createApp();
    const drag = await request(app).post('/api/series/standup/drags')
      .send({revision: 1, intent: {ruleId: 'standup-1', recurrenceId: '20260308T090000', cancel: true, scope: 'this', zone: 'America/New_York'}})
      .expect(200);
    await request(app).post('/api/series/standup/touch').send({}).expect(200);
    const inverse = invertChange(drag.body.appliedChange);
    const res = await request(app).post('/api/series/standup/changes')
      .send({revision: 2, change: inverse}) // rev is actually 3
      .expect(409);
    expect(res.body.current.series.revision).toBe(3);
  });
});

describe('COUNT and monthly seeds', () => {
  it('COUNT series splits with the remainder carried forward', async () => {
    const app = createApp();
    const res = await request(app).post('/api/series/sprints/drags')
      .send({revision: 1, intent: {ruleId: 'sprints-1', recurrenceId: '20260928T150000', newStart: '20260929T150000', scope: 'thisAndFuture', zone: 'UTC'}})
      .expect(200);
    const [, tail] = res.body.series.rules;
    expect(tail.rrule.count).toBe(3); // Sep 28, Oct 5, Oct 12
  });

  it('month-end series skips February and April without rolling', async () => {
    const app = createApp();
    const body = await request(app).get('/api/series/payday').expect(200);
    const keys = body.body.occurrences.slice(0, 5).map((o: {start: string}) => o.start.slice(0, 8));
    expect(keys).toEqual(['20260131', '20260331', '20260531', '20260731', '20260831']);
  });
});
