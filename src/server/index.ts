import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  applyInverse,
  applyMove,
  expandOccurrences,
  listOccurrences,
  localPartsToUtc,
  parseLocal,
  MoveError,
  type InverseOp,
  type MoveScope,
  type Rule,
  type Store,
} from '../shared/recurrence';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary occurrence sets',revision:3,content:'occurrence sets: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary occurrence sets',revision:5,content:'occurrence sets: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

function buildSeedStore(): Store {
  const rules: Rule[] = [
    {id:'standup',title:'Daily standup',tz:'America/New_York',startLocal:'2026-03-02T09:00',durationMin:30,rrule:{freq:'DAILY',interval:1,count:12},revision:1},
    {id:'monthly-report',title:'Monthly report (31st)',tz:'America/New_York',startLocal:'2026-01-31T15:00',durationMin:60,rrule:{freq:'MONTHLY',interval:1,byMonthDay:[31]},revision:1},
    {id:'weekly-sync',title:'Weekly sync',tz:'UTC',startLocal:'2026-03-04T14:00',durationMin:45,rrule:{freq:'WEEKLY',interval:1,byWeekDay:['WE'],until:'2026-05-30T00:00:00.000Z'},revision:1},
  ];
  const store: Store = {rules, exceptions: []};
  const standupOccurrences = listOccurrences(rules[0]);
  store.exceptions.push(
    {id:'ex-seed-1',ruleId:'standup',originalStart:standupOccurrences[2].utc,kind:'excluded'},
    {id:'ex-seed-2',ruleId:'standup',originalStart:standupOccurrences[5].utc,kind:'modified',newStart:new Date(Date.parse(standupOccurrences[5].utc)+2*3_600_000).toISOString()},
  );
  return store;
}

interface UndoEntry {label:string;inverse:InverseOp[]}

export interface CreateAppOptions {store?: Store}

export function createApp(options: CreateAppOptions = {}){
  const app=express();
  app.use(express.json({limit:'1mb'}));

  const store: Store = options.store ?? buildSeedStore();
  const undoStack: UndoEntry[] = [];

  const findRule=(id:string)=>store.rules.find(rule=>rule.id===id);
  const ruleState=(rule:Rule)=>({rule,exceptions:store.exceptions.filter(e=>e.ruleId===rule.id)});
  const parseMoveBody=(body:Record<string,unknown>)=>({
    ruleId:String(body.ruleId??''),
    originalStart:String(body.originalStart??''),
    newStart:String(body.newStart??''),
    scope:(body.scope==='following'?'following':'single') as MoveScope,
  });
  const moveErrorResponse=(res:express.Response,err:unknown)=>{
    if(err instanceof MoveError)return res.status(422).json({error:err.code,message:err.message});
    throw err;
  };

  app.get('/api/bootstrap',(_req,res)=>res.json({family:"recurrence-rule",count:rows.length}));
  app.get('/api/schedules',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/schedules/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/schedules/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/schedules/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  // --- Recurrence rules -------------------------------------------------

  app.get('/api/rules',(_req,res)=>res.json(store.rules));

  app.get('/api/rules/:id/occurrences',(req,res)=>{
    const rule=findRule(req.params.id);
    if(!rule)return res.status(404).json({error:'rule_not_found'});
    const from=req.query.from?Date.parse(String(req.query.from)):localPartsToUtc(parseLocal(rule.startLocal),rule.tz)-86_400_000;
    const to=req.query.to?Date.parse(String(req.query.to)):from+42*86_400_000;
    res.json({...ruleState(rule),occurrences:expandOccurrences(rule,store.exceptions,from,to),canUndo:undoStack.length>0});
  });

  // Predicted result of a drag, computed on a throwaway copy of the store.
  app.post('/api/rules/:id/move-preview',(req,res)=>{
    const rule=findRule(req.params.id);
    if(!rule)return res.status(404).json({error:'rule_not_found'});
    const scratch=structuredClone(store);
    try{
      const result=applyMove(scratch,{...parseMoveBody(req.body),ruleId:rule.id});
      res.json({changes:result.changes,revision:rule.revision});
    }catch(err){moveErrorResponse(res,err)}
  });

  // Commit a drag. Optimistic concurrency: the client must present the rule
  // revision it previewed against; on mismatch nothing is applied and the
  // current state is returned so the client can re-apply its drag intent.
  app.post('/api/rules/:id/move',(req,res)=>{
    const rule=findRule(req.params.id);
    if(!rule)return res.status(404).json({error:'rule_not_found'});
    if(req.body.revision!==rule.revision){
      return res.status(409).json({error:'revision_conflict',current:ruleState(rule)});
    }
    try{
      const move=parseMoveBody(req.body);
      const result=applyMove(store,{...move,ruleId:rule.id});
      undoStack.push({label:`${move.scope} move on ${rule.id} @ ${move.originalStart}`,inverse:result.inverse});
      res.json({changes:result.changes,revision:rule.revision,canUndo:true});
    }catch(err){moveErrorResponse(res,err)}
  });

  // Undo replays structured inverse operations — no collection snapshots.
  app.post('/api/undo',(_req,res)=>{
    const entry=undoStack.pop();
    if(!entry)return res.status(404).json({error:'nothing_to_undo'});
    applyInverse(store,entry.inverse);
    res.json({undone:entry.label,canUndo:undoStack.length>0});
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
