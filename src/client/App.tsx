import {useCallback, useEffect, useMemo, useState} from 'react';
import {AlertTriangle, FlaskConical, Save, Undo2, RefreshCw, GitBranch} from 'lucide-react';
import Timeline from './Timeline';
import {listSeries, loadSeries, previewDrag, saveChange, saveDrag, touch} from './api';
import type {Occurrence, SeriesPayload} from './types';
import type {Change, DragRequest, DragScope} from '../shared/operations';
import {invertChange} from '../shared/operations';
import {addDays, isoWall, parseWall, wallKey} from '../shared/wall';

type Summary = {id: string; title: string; revision: number; ruleCount: number};

type Pending = {
  intent: DragRequest;
  scope: DragScope;
  preview: SeriesPayload & {change?: Change; diagnostics?: string[]};
  status: number;
};

type UndoEntry = {
  label: string;
  change: Change; // the change as applied; undo sends its structural inverse
  revision: number; // revision the change was applied at
};

const WINDOW_DAYS = 42;

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('standup');
  const [payload, setPayload] = useState<SeriesPayload | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [status, setStatus] = useState('Ready');
  const [conflict, setConflict] = useState<{intent: DragRequest; scope: DragScope; current: SeriesPayload} | null>(null);

  const refresh = useCallback(async (id: string) => {
    const value = await loadSeries(id);
    setPayload(value);
    return value;
  }, []);

  useEffect(() => {
    listSeries().then(setItems);
  }, []);

  useEffect(() => {
    setPending(null);
    setConflict(null);
    setUndoStack([]);
    refresh(selected);
  }, [selected, refresh]);

  const windowStart = useMemo(() => {
    if (!payload) return '20260301T000000';
    const earliest = payload.series.rules.reduce((a, r) => (r.dtstart < a ? r.dtstart : a), payload.series.rules[0].dtstart);
    return wallKey({...parseWall(earliest), h: 0, mi: 0, s: 0});
  }, [payload]);

  // --- pending drag / preview ------------------------------------------------

  const startDrag = useCallback(
    async (occ: Occurrence, newKey: string, cancel = false) => {
      if (!payload) return;
      const intent: DragRequest = {
        ruleId: occ.ruleId,
        recurrenceId: occ.start,
        newStart: cancel ? undefined : newKey,
        cancel,
        scope: 'this',
        zone: payload.series.zone,
      };
      const res = await previewDrag(payload.series.id, payload.series.revision, intent);
      if (res.status === 409) {
        // Revision moved under us: preserve intent and offer re-apply.
        setConflict({intent, scope: 'this', current: res.body.current});
        setStatus('Revision conflict — drag intent kept');
        return;
      }
      if (!res.ok) {
        setStatus(`Cannot drag: ${res.body.message ?? res.body.error}`);
        return;
      }
      setPending({intent, scope: 'this', preview: res.body, status: res.status});
      setStatus('Preview: edit this occurrence');
    },
    [payload],
  );

  const changeScope = useCallback(
    async (scope: DragScope) => {
      if (!pending || !payload) return;
      const intent = {...pending.intent, scope};
      const res = await previewDrag(payload.series.id, payload.series.revision, intent);
      if (res.status === 409) {
        setConflict({intent, scope, current: res.body.current});
        setStatus('Revision conflict — drag intent kept');
        return;
      }
      setPending({intent, scope, preview: res.body, status: res.status});
      setStatus(scope === 'this' ? 'Preview: edit this occurrence' : 'Preview: split and move from here');
    },
    [pending, payload],
  );

  // --- save ------------------------------------------------------------------

  const commit = useCallback(async () => {
    if (!pending || !payload) return;
    const res = await saveDrag(payload.series.id, payload.series.revision, pending.intent);
    if (res.status === 409) {
      setConflict({intent: pending.intent, scope: pending.scope, current: res.body.current});
      setPending(null);
      setStatus('Revision conflict on save — pick the newer series and re-apply');
      return;
    }
    if (!res.ok) {
      setStatus(`Save rejected: ${res.body.message ?? res.body.error}`);
      return;
    }
    const applied: Change = res.body.appliedChange;
    setUndoStack((s) => [{label: applied.label, change: applied, revision: payload.series.revision}, ...s].slice(0, 20));
    setPayload(res.body);
    setPending(null);
    setStatus(`Saved at revision ${res.body.series.revision}`);
    listSeries().then(setItems);
  }, [pending, payload]);

  const reapplyOnCurrent = useCallback(async () => {
    if (!conflict) return;
    // Adopt the newer revision, then run the SAME intent through preview again
    // — buildDragChange re-resolves the owning segment on the fresh series.
    setPayload(conflict.current);
    const res = await previewDrag(conflict.current.series.id, conflict.current.series.revision, conflict.intent);
    if (res.status === 409) {
      setConflict({...conflict, current: res.body.current});
      setStatus('Still conflicting — another edit landed');
      return;
    }
    if (!res.ok) {
      setStatus(`Re-apply rejected: ${res.body.message ?? res.body.error}`);
      setConflict(null);
      return;
    }
    setPending({intent: conflict.intent, scope: conflict.scope, preview: res.body, status: res.status});
    setConflict(null);
    setStatus('Drag re-applied on the newer revision — review and save');
  }, [conflict]);

  const discardConflict = useCallback(() => {
    setConflict(null);
    if (conflict) setPayload(conflict.current);
    setStatus('Discarded stale drag');
  }, [conflict]);

  // --- undo (structured inverse, no whole-collection snapshots) --------------

  const undo = useCallback(
    async (entry: UndoEntry) => {
      if (!payload) return;
      const inverse = invertChange(entry.change);
      const res = await saveChange(payload.series.id, payload.series.revision, inverse);
      if (res.status === 409) {
        // Even undo goes through optimistic concurrency; the inverse ops are
        // idempotently rebased by the server's current rules.
        setStatus('Cannot undo: the series changed since — reload and retry');
        setPayload(res.body.current ?? payload);
        return;
      }
      if (!res.ok) {
        setStatus(`Undo rejected: ${res.body.message ?? res.body.error}`);
        return;
      }
      setPayload(res.body);
      setUndoStack((s) => s.filter((e) => e !== entry));
      setPending(null);
      setStatus(`Undid "${entry.label}" at revision ${res.body.series.revision}`);
      listSeries().then(setItems);
    },
    [payload],
  );

  // Dev helper: a concurrent writer bumps the revision so the 409 path can be
  // exercised without a second browser.
  const simulateConflict = useCallback(async () => {
    if (!payload) return;
    const value = await touch(payload.series.id);
    setPayload(value);
    setStatus('Another client bumped the revision — try saving the pending drag');
  }, [payload]);

  const shown = pending?.preview ?? payload;
  const diagnosticItems = pending?.preview.diagnostics ?? [];

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Recurrence Rule Studio</strong>
        <small>{payload?.series.zone ?? ''} · rev {payload?.series.revision ?? '…'}</small>
        <span className="spacer" />
        <button className="ghost" onClick={simulateConflict} title="Simulate a concurrent revision bump">
          <GitBranch size={14} /> simulate conflict
        </button>
      </header>

      <section className="workspace">
        <aside className="pane">
          <h2>Series</h2>
          <div className="list">
            {items.map((item) => (
              <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
                {item.title}
                <br />
                <small>
                  rev {item.revision} · {item.ruleCount} segment{item.ruleCount === 1 ? '' : 's'}
                </small>
              </button>
            ))}
          </div>

          <h2>Undo</h2>
          <p className="hint">Each entry is reverted by sending its structural inverse ops, not an old snapshot.</p>
          <div className="undo-list">
            {undoStack.length === 0 && <em className="hint">nothing to undo</em>}
            {undoStack.map((entry, i) => (
              <button key={i} className="undo-entry" onClick={() => undo(entry)}>
                <Undo2 size={13} /> {entry.label} <small>@rev {entry.revision}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane timeline-pane">
          <div className="toolbar">
            <span className="status">{status}</span>
            {pending && (
              <div className="scope-bar">
                <div className="scope-toggle">
                  <button className={pending.scope === 'this' ? 'primary' : ''} onClick={() => changeScope('this')}>
                    Only this one
                  </button>
                  <button className={pending.scope === 'thisAndFuture' ? 'primary' : ''} onClick={() => changeScope('thisAndFuture')}>
                    This and all following
                  </button>
                </div>
                <button className="primary" onClick={commit}>
                  <Save size={15} /> Save (rev {payload?.series.revision})
                </button>
                <button onClick={() => { setPending(null); setStatus('Preview discarded'); }}>
                  <RefreshCw size={14} /> Discard
                </button>
              </div>
            )}
          </div>
          <div className={pending ? 'previewing' : ''}>
            {shown && (
              <Timeline
                occurrences={shown.occurrences.filter((o) => o.start >= windowStart && o.start < wallKey(addDays(parseWall(windowStart), WINDOW_DAYS)))}
                zone={shown.series.zone}
                dst={shown.dst}
                windowStart={windowStart}
                windowDays={WINDOW_DAYS}
                onDragCommit={(occ, key) => startDrag(occ, key)}
                onCancelOne={(occ) => startDrag(occ, occ.start, true)}
                onResetOne={async (occ) => {
                  // Reset = same-as-cancel toggle removal; preview a plain move back.
                  return startDrag(occ, occ.start);
                }}
              />
            )}
          </div>
        </section>

        <aside className="pane inspect">
          <h2>Prediction</h2>
          {pending ? (
            <>
              <p className="hint">
                Not saved yet. Server predicted this result from revision{' '}
                <strong>{payload?.series.revision}</strong>.
              </p>
              {pending.scope === 'thisAndFuture' && (
                <div className="note">
                  <strong>Split:</strong> the current rule gains an UNTIL one second before the dragged
                  occurrence; a new segment starts there. Existing exceptions at/after the split migrate with it.
                </div>
              )}
              {pending.scope === 'this' && (
                <div className="note">
                  <strong>Single occurrence:</strong> one exception keyed by the original recurrence-id —
                  a replacement time, or an EXDATE if cancelled.
                </div>
              )}
              {diagnosticItems.length > 0 && (
                <div className="warn">
                  <AlertTriangle size={14} /> {diagnosticItems.join('; ')}
                </div>
              )}
              <details open>
                <summary>Structured change ({pending.preview.change?.ops.length ?? 0} ops)</summary>
                <pre>{JSON.stringify(pending.preview.change, null, 2)}</pre>
              </details>
            </>
          ) : (
            <p className="hint">Drag an occurrence onto another day, or use ✕ to cancel just one. Choose scope, then save.</p>
          )}

          {conflict && (
            <div className="conflict">
              <h3><AlertTriangle size={15} /> Revision conflict</h3>
              <p>
                The series is now at revision <strong>{conflict.current.series.revision}</strong>. Your drag
                intent ({isoWall(parseWall(conflict.intent.recurrenceId))}
                {conflict.intent.cancel ? ', cancel' : ` → ${conflict.intent.newStart ? isoWall(parseWall(conflict.intent.newStart)) : ''}`},
                {' '}{conflict.scope === 'this' ? 'only this' : 'this and following'}) has been retained.
              </p>
              <button className="primary" onClick={reapplyOnCurrent}>
                <RefreshCw size={14} /> Re-apply on revision {conflict.current.series.revision}
              </button>
              <button onClick={discardConflict}>Discard drag</button>
            </div>
          )}

          <h2>DST audit</h2>
          {shown?.dst.length ? (
            <ul className="dst-list">
              {shown.dst.slice(0, 8).map((n) => (
                <li key={n.occurrenceUid + n.start}>
                  <code>{isoWall(parseWall(n.start))}</code>
                  <p>{n.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <em className="hint">no transitions in this window</em>
          )}

          <h2>Rule segments</h2>
          {shown?.series.rules.map((rule) => (
            <div className="rule-card" key={rule.id}>
              <code>{rule.id}</code>
              <pre>
                {JSON.stringify(rule.rrule)}
                {'\n'}DTSTART {rule.dtstart}
                {'\n'}exceptions {rule.exceptions.length}
              </pre>
            </div>
          ))}
        </aside>
      </section>
    </main>
  );
}
