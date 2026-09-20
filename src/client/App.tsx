import {useCallback,useEffect,useState} from 'react';
import {AlertTriangle,CalendarClock,Eye,RotateCcw,Save,X} from 'lucide-react';
import {
  formatLocal,
  localPartsToUtc,
  parseLocal,
  utcToLocalParts,
  type ChangeSet,
  type ExpandedOccurrence,
  type MoveScope,
  type OccurrenceException,
  type Rule,
} from '../shared/recurrence';

interface RulePayload{rule:Rule;exceptions:OccurrenceException[];occurrences:ExpandedOccurrence[];canUndo:boolean}
interface DragIntent{originalStart:string;originalLocal:string;newLocal:string;scope:MoveScope}

const WINDOW_DAYS=28;

function addDaysToKey(key:string,n:number):string{
  const [y,m,d]=key.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10);
}
function mondayOf(key:string):string{
  const [y,m,d]=key.split('-').map(Number);
  const jsDay=new Date(Date.UTC(y,m-1,d)).getUTCDay();
  return addDaysToKey(key,-((jsDay+6)%7));
}
function dayKeyOf(utcIso:string,tz:string):string{
  return formatLocal(utcToLocalParts(Date.parse(utcIso),tz)).slice(0,10);
}
function timeOf(utcIso:string,tz:string):string{
  return formatLocal(utcToLocalParts(Date.parse(utcIso),tz)).slice(11);
}
function describeRRule(rule:Rule):string{
  const r=rule.rrule;
  const unit=r.freq==='DAILY'?'天':r.freq==='WEEKLY'?'周':'月';
  const parts=[r.interval>1?`每 ${r.interval} ${unit}`:`每${unit}`];
  if(r.byWeekDay?.length)parts.push(r.byWeekDay.join('/'));
  if(r.byMonthDay?.length)parts.push(`${r.byMonthDay.join(',')} 日`);
  if(r.count!=null)parts.push(`共 ${r.count} 次`);
  if(r.until)parts.push(`至 ${r.until.slice(0,10)}`);
  return parts.join(' · ');
}

function ChangesView({changes}:{changes:ChangeSet}){
  return <div className="changes">
    {changes.addedException&&<p>新增修改例外：原 {changes.addedException.originalStart} → {changes.addedException.newStart}</p>}
    {changes.updatedException&&<p>更新修改例外：{changes.updatedException.before.newStart} → {changes.updatedException.after.newStart}</p>}
    {changes.truncatedRule&&<p>原规则截断：{changes.truncatedRule.count!=null?`COUNT=${changes.truncatedRule.count} `:''}{changes.truncatedRule.until?`UNTIL=${changes.truncatedRule.until}`:''}</p>}
    {changes.newRule&&<p>新规则「{changes.newRule.title}」：起始 {changes.newRule.startLocal}（{changes.newRule.tz}）{changes.newRule.rrule.count!=null?`，共 ${changes.newRule.rrule.count} 次`:''}{changes.newRule.rrule.until?`，至 ${changes.newRule.rrule.until.slice(0,10)}`:''}</p>}
    {changes.migratedExceptions&&changes.migratedExceptions.length>0&&<p>迁移 {changes.migratedExceptions.length} 条后半段例外到新规则</p>}
  </div>;
}

export default function App(){
  const [rules,setRules]=useState<Rule[]>([]);
  const [selected,setSelected]=useState<string>('');
  const [payload,setPayload]=useState<RulePayload|null>(null);
  const [windowStart,setWindowStart]=useState('');
  const [dragging,setDragging]=useState<ExpandedOccurrence|null>(null);
  const [intent,setIntent]=useState<DragIntent|null>(null);
  const [preview,setPreview]=useState<ChangeSet|null>(null);
  const [conflict,setConflict]=useState<string|null>(null);
  const [status,setStatus]=useState('Ready');

  const loadRules=useCallback(async()=>{
    const value:Rule[]=await (await fetch('/api/rules')).json();
    setRules(value);
    setSelected(current=>current||value[0]?.id||'');
  },[]);

  const refresh=useCallback(async(ruleId:string,fromKey:string)=>{
    if(!ruleId||!fromKey)return;
    const from=`${fromKey}T00:00:00.000Z`;
    const to=`${addDaysToKey(fromKey,WINDOW_DAYS+7)}T00:00:00.000Z`;
    const value:RulePayload=await (await fetch(`/api/rules/${ruleId}/occurrences?from=${from}&to=${to}`)).json();
    setPayload(value);
  },[]);

  useEffect(()=>{loadRules()},[loadRules]);
  // 切换规则：重置时间轴窗口与未保存的拖动意图。
  useEffect(()=>{
    const found=rules.find(r=>r.id===selected);
    if(!found)return;
    setWindowStart(mondayOf(found.startLocal.slice(0,10)));
    setIntent(null);setPreview(null);setConflict(null);
  },[selected]);// eslint-disable-line react-hooks/exhaustive-deps
  // 数据刷新：规则列表或窗口变化时重取 occurrences（保存/撤销后保留窗口位置）。
  useEffect(()=>{refresh(selected,windowStart)},[rules,selected,windowStart,refresh]);

  const rule=payload?.rule??null;

  function toUtcIso(local:string):string{
    return new Date(localPartsToUtc(parseLocal(local),rule!.tz)).toISOString();
  }

  function onDrop(dayKey:string){
    if(!dragging||!rule)return;
    setIntent({
      originalStart:dragging.originalStart,
      originalLocal:dragging.local,
      newLocal:`${dayKey}T${dragging.local.slice(11)}`,
      scope:'single',
    });
    setPreview(null);setConflict(null);
    setDragging(null);
  }

  async function runPreview(current:DragIntent){
    if(!rule)return;
    setStatus('Previewing');
    const res=await fetch(`/api/rules/${rule.id}/move-preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({originalStart:current.originalStart,newStart:toUtcIso(current.newLocal),scope:current.scope})});
    const value=await res.json();
    if(!res.ok){setPreview(null);setStatus(`预览失败：${value.message??value.error}`);return}
    setPreview(value.changes);setStatus('Ready');
  }

  async function save(){
    if(!rule||!intent)return;
    setStatus('Saving');
    const res=await fetch(`/api/rules/${rule.id}/move`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({originalStart:intent.originalStart,newStart:toUtcIso(intent.newLocal),scope:intent.scope,revision:rule.revision})});
    const value=await res.json();
    if(res.status===409){
      // 保留拖动意图：刷新到最新 revision，并在其上重新计算预览。
      await loadRules();
      await runPreview(intent);
      setConflict(`规则已被并发修改（当前 revision ${value.current.rule.revision}）。拖动意图已保留，预览已在新 revision 上重算，可直接再次保存。`);
      setStatus('Conflict');
      return;
    }
    if(!res.ok){setStatus(`保存失败：${value.message??value.error}`);return}
    setIntent(null);setPreview(null);setConflict(null);
    await loadRules();
    setStatus('Saved');
  }

  async function undo(){
    const res=await fetch('/api/undo',{method:'POST'});
    if(res.ok){await loadRules();setStatus('Undone')}
  }

  const days=windowStart?Array.from({length:WINDOW_DAYS},(_,i)=>addDaysToKey(windowStart,i)):[];
  const byDay=new Map<string,ExpandedOccurrence[]>();
  if(rule)for(const occ of payload!.occurrences){
    const key=dayKeyOf(occ.start,rule.tz);
    byDay.set(key,[...(byDay.get(key)??[]),occ]);
  }

  return <main className="shell">
    <header className="topbar"><CalendarClock size={20}/><strong>Recurrence Rule Studio</strong><small>拖动 occurrence：仅本次 / 从本次起</small></header>
    <section className="workspace">
      <aside className="pane">
        <h2>Rules</h2>
        <div className="list">{rules.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.title}<br/><small>{describeRRule(item)}</small><br/><small>Revision {item.revision}</small></button>)}</div>
      </aside>
      <section className="pane">
        <div className="toolbar">
          <button onClick={()=>setWindowStart(addDaysToKey(windowStart,-WINDOW_DAYS))}>‹ 前 4 周</button>
          <button onClick={()=>setWindowStart(addDaysToKey(windowStart,WINDOW_DAYS))}>后 4 周 ›</button>
          <button onClick={undo} disabled={!payload?.canUndo}><RotateCcw size={15}/>撤销</button>
          <span>{status}</span>
        </div>
        {rule&&<p className="hint">{rule.title} · {rule.tz} · {describeRRule(rule)} · revision {rule.revision}。拖动色块到目标日期。</p>}
        <div className="timeline">
          {days.map(day=><div className="day" key={day} onDragOver={event=>event.preventDefault()} onDrop={()=>onDrop(day)}>
            <header>{day.slice(5)}</header>
            {(byDay.get(day)??[]).map(occ=><div
              key={occ.id}
              className={`chip${occ.excluded?' excluded':''}${occ.modified?' modified':''}`}
              draggable={!occ.excluded}
              onDragStart={()=>setDragging(occ)}
              title={`原始 ${occ.originalStart}`}>
              {timeOf(occ.start,rule!.tz)}{occ.modified?' ↦':''}{occ.excluded?' ✕':''}
            </div>)}
          </div>)}
        </div>
      </section>
      <aside className="pane">
        <h2>Exceptions</h2>
        {payload?.exceptions.map(ex=><p key={ex.id} className="exitem"><span className="pill">{ex.kind==='excluded'?'排除':'替代'}</span> 原 {ex.originalStart}{ex.newStart?<> → {ex.newStart}</>:null}</p>)}
        {preview&&<><h2>预测结果</h2><ChangesView changes={preview}/></>}
      </aside>
    </section>
    {intent&&<div className="overlay"><div className="dialog">
      <header><strong>移动 occurrence</strong><button className="icon" onClick={()=>{setIntent(null);setPreview(null);setConflict(null)}}><X size={16}/></button></header>
      <p>原时间：<code>{intent.originalLocal}</code>（{rule?.tz}）</p>
      <label>新时间 <input type="datetime-local" value={intent.newLocal} onChange={event=>{setIntent({...intent,newLocal:event.target.value});setPreview(null)}}/></label>
      <fieldset>
        <label><input type="radio" checked={intent.scope==='single'} onChange={()=>{setIntent({...intent,scope:'single'});setPreview(null)}}/> 仅本次（记录一条修改例外）</label>
        <label><input type="radio" checked={intent.scope==='following'} onChange={()=>{setIntent({...intent,scope:'following'});setPreview(null)}}/> 从本次起（截断原规则并生成新规则，迁移后半段例外）</label>
      </fieldset>
      {conflict&&<p className="conflict"><AlertTriangle size={14}/> {conflict}</p>}
      {preview&&<ChangesView changes={preview}/>}
      <footer>
        <button onClick={()=>runPreview(intent)}><Eye size={15}/>预览</button>
        <button className="primary" onClick={save}><Save size={15}/>保存（revision {rule?.revision}）</button>
      </footer>
    </div></div>}
  </main>;
}
