import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {listOccurrences,type Rule,type Store} from '../src/shared/recurrence';

describe('service',()=>{it('loads and conditionally updates a record',async()=>{const app=createApp();const before=await request(app).get('/api/schedules/alpha').expect(200);await request(app).put('/api/schedules/alpha').send({content:'updated',revision:before.body.revision}).expect(200);await request(app).put('/api/schedules/alpha').send({content:'stale',revision:before.body.revision}).expect(409)})});

function dailyStore():Store{
  const rule:Rule={id:'r1',title:'Daily',tz:'UTC',startLocal:'2026-01-01T09:00',durationMin:30,rrule:{freq:'DAILY',interval:1,count:6},revision:1};
  const occ=listOccurrences(rule);
  return {rules:[rule],exceptions:[{id:'ex-1',ruleId:'r1',originalStart:occ[4].utc,kind:'excluded'}]};
}

describe('recurrence api',()=>{
  it('previews a move without mutating state',async()=>{
    const store=dailyStore();
    const app=createApp({store});
    const occ=listOccurrences(store.rules[0]);
    const before=await request(app).get('/api/rules/r1/occurrences').expect(200);
    const preview=await request(app).post('/api/rules/r1/move-preview').send({originalStart:occ[2].utc,newStart:'2026-01-03T15:00:00.000Z',scope:'following'}).expect(200);
    expect(preview.body.changes.truncatedRule.count).toBe(2);
    expect(preview.body.changes.newRule.startLocal).toBe('2026-01-03T15:00');
    const after=await request(app).get('/api/rules/r1/occurrences').expect(200);
    expect(after.body.rule.revision).toBe(before.body.rule.revision);
    expect(after.body.occurrences.length).toBe(before.body.occurrences.length);
    expect(store.rules).toHaveLength(1);
    expect(store.exceptions).toHaveLength(1);
  });

  it('rejects a stale revision and lets the client re-apply the same drag intent',async()=>{
    const store=dailyStore();
    const app=createApp({store});
    const occ=listOccurrences(store.rules[0]);
    const staleRevision=store.rules[0].revision;
    // 并发修改先落库，revision +1
    await request(app).post('/api/rules/r1/move').send({originalStart:occ[1].utc,newStart:'2026-01-02T12:00:00.000Z',scope:'single',revision:staleRevision}).expect(200);
    // 携带旧 revision 的拖动意图被拒绝，且没有任何部分写入
    const conflict=await request(app).post('/api/rules/r1/move').send({originalStart:occ[3].utc,newStart:'2026-01-04T16:00:00.000Z',scope:'single',revision:staleRevision}).expect(409);
    expect(conflict.body.error).toBe('revision_conflict');
    expect(conflict.body.current.rule.revision).toBe(staleRevision+1);
    expect(store.exceptions.filter(e=>e.originalStart===occ[3].utc)).toHaveLength(0);
    // 同一拖动意图在新 revision 上重新应用成功
    const retry=await request(app).post('/api/rules/r1/move').send({originalStart:occ[3].utc,newStart:'2026-01-04T16:00:00.000Z',scope:'single',revision:conflict.body.current.rule.revision}).expect(200);
    expect(retry.body.changes.addedException).toMatchObject({originalStart:occ[3].utc,newStart:'2026-01-04T16:00:00.000Z'});
    expect(store.exceptions.filter(e=>e.originalStart===occ[3].utc)).toHaveLength(1);
  });

  it('applies this-and-following with exception migration, then undoes it structurally',async()=>{
    const store=dailyStore();
    const app=createApp({store});
    const rule=store.rules[0];
    const occ=listOccurrences(rule);
    const res=await request(app).post('/api/rules/r1/move').send({originalStart:occ[3].utc,newStart:'2026-01-04T18:00:00.000Z',scope:'following',revision:rule.revision}).expect(200);
    expect(store.rules).toHaveLength(2);
    expect(res.body.changes.truncatedRule.count).toBe(3);
    // 既有排除例外（旧下标 4）迁移到后继规则（新下标 1），身份重映射
    expect(store.exceptions[0].ruleId).toBe(store.rules[1].id);
    expect(store.exceptions[0].originalStart).toBe('2026-01-05T18:00:00.000Z');
    // 撤销：恢复原规则与例外归属，不依赖整库快照
    await request(app).post('/api/undo').expect(200);
    expect(store.rules).toHaveLength(1);
    expect(store.rules[0].rrule.count).toBe(6);
    expect(store.rules[0].rrule.until).toBeUndefined();
    expect(store.exceptions[0]).toMatchObject({ruleId:'r1',originalStart:occ[4].utc});
    await request(app).post('/api/undo').expect(404);
  });

  it('rejects invalid moves with 422',async()=>{
    const store=dailyStore();
    const app=createApp({store});
    const occ=listOccurrences(store.rules[0]);
    await request(app).post('/api/rules/r1/move').send({originalStart:occ[0].utc,newStart:occ[0].utc,scope:'following',revision:1}).expect(422);
    await request(app).post('/api/rules/r1/move').send({originalStart:occ[4].utc,newStart:occ[4].utc,scope:'single',revision:1}).expect(422); // 已排除的 occurrence
    expect(store.rules).toHaveLength(1);
  });
});
