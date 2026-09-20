import {useState} from 'react';
import type {DstNote, Occurrence} from './types';
import {addDays, isoWall, parseWall, wallKey} from '../shared/wall';

type Drag = {
  occurrence: Occurrence;
  startKey: string;
  newKey: string;
};

function dayKey(k: string): string {
  return k.slice(0, 8);
}

function humanDay(k: string): string {
  const w = parseWall(k);
  return `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

function humanTime(k: string): string {
  return k.slice(9, 11) + ':' + k.slice(11, 13);
}

const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Timeline(props: {
  occurrences: Occurrence[];
  zone: string;
  dst: DstNote[];
  windowStart: string;
  windowDays: number;
  onDragCommit: (occ: Occurrence, newKey: string) => void;
  onCancelOne: (occ: Occurrence) => void;
  onResetOne: (occ: Occurrence) => void;
}) {
  const {occurrences, dst, windowStart, windowDays} = props;
  const [live, setLive] = useState<Drag | null>(null);

  const byDay = new Map<string, Occurrence[]>();
  for (const occ of occurrences) {
    const dk = dayKey(occ.effectiveStart);
    const list = byDay.get(dk) ?? [];
    list.push(occ);
    byDay.set(dk, list);
  }

  const dstByStart = new Map(dst.map((n) => [n.start, n]));

  const days: string[] = [];
  const firstDay = dayKey(windowStart);
  for (let i = 0; i < windowDays; i++) {
    days.push(wallKey(addDays(parseWall(firstDay + 'T000000'), i)).slice(0, 8));
  }

  function allowDrop(event: React.DragEvent) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  return (
    <div className="timeline" data-testid="timeline">
      {days.map((dk) => {
        const w = parseWall(dk + 'T120000');
        const list = byDay.get(dk) ?? [];
        const isToday = false;
        return (
          <div
            key={dk}
            className={`tl-day${live ? ' droppable' : ''}`}
            onDragOver={allowDrop}
            onDrop={(event) => {
              event.preventDefault();
              if (live) {
                // Preserve the dragged occurrence's time of day; only the date moves.
                const newKey = dk + live.startKey.slice(8);
                props.onDragCommit(live.occurrence, newKey);
                setLive(null);
              }
            }}
          >
            <div className="tl-date">
              <span className="tl-dow">{WEEK[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]}</span>
              <strong>{humanDay(dk + 'T000000')}</strong>
              {isToday && <em className="tl-today">today</em>}
            </div>
            <div className="tl-items">
              {list.length === 0 && <span className="tl-empty">—</span>}
              {list.map((occ) => {
                const note = dstByStart.get(occ.effectiveStart);
                const moved = occ.status !== 'ok';
                const draggedNow = live?.occurrence.uid === occ.uid;
                return (
                  <div
                    key={occ.uid}
                    className={`tl-item ${occ.status}${draggedNow ? ' dragging' : ''}${note ? ' dst' : ''}`}
                    draggable={occ.status !== 'cancelled'}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', occ.uid);
                      setLive({occurrence: occ, startKey: occ.start, newKey: occ.effectiveStart});
                    }}
                    onDragEnd={() => setLive(null)}
                    title={note?.message ?? (moved ? `originally ${isoWall(parseWall(occ.start))}` : '')}
                  >
                    <span className="tl-time">{humanTime(occ.effectiveStart)}</span>
                    <span className="tl-state">
                      {occ.status === 'moved' && 'moved'}
                      {occ.status === 'cancelled' && 'cancelled'}
                      {note && <em className="tl-dst" title={note.message}>DST</em>}
                    </span>
                    <span className="tl-actions">
                      {occ.status !== 'cancelled' && (
                        <button
                          className="mini"
                          title="Cancel just this occurrence"
                          onClick={() => props.onCancelOne(occ)}
                        >
                          ✕
                        </button>
                      )}
                      {occ.status !== 'ok' && (
                        <button
                          className="mini"
                          title="Restore original occurrence"
                          onClick={() => props.onResetOne(occ)}
                        >
                          ↺
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
