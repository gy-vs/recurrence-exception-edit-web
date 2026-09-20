import {Occurrence} from './model';
import {Wall, WallInstant, isoWall, parseWall, wallToInstant} from './wall';

export type DstNote = {
  occurrenceUid: string;
  start: string;
  /** Offset before this occurrence (ms), undefined for the first one. */
  prevOffsetMs?: number;
  offsetMs: number;
  kind: WallInstant['kind'];
  /** True when this occurrence crosses a DST transition relative to the prior one. */
  crossesBoundary: boolean;
  message: string;
};

function describeOffset(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms) / 60000;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/**
 * Audit effective occurrences against the zone wall clock. Recurrence math is
 * zone-agnostic: a 09:00 wall time stays 09:00 across a DST boundary (its UTC
 * instant shifts). Here we surface, per occurrence:
 *  - the offset in effect,
 *  - whether a transition was crossed relative to the previous occurrence,
 *  - whether the requested wall time lands in a spring-forward gap (the instant
 *    resolves forward) or a fall-back overlap (the earlier instant is chosen).
 */
export function auditDst(occurrences: Occurrence[], zone: string): DstNote[] {
  const notes: DstNote[] = [];
  let prevOffset: number | undefined;
  let prevStart: string | undefined;
  for (const occ of occurrences) {
    if (occ.status === 'cancelled') continue;
    const resolved = wallToInstant(parseWall(occ.effectiveStart), zone);
    const crossesBoundary = prevOffset !== undefined && resolved.offsetMs !== prevOffset;
    if (resolved.kind !== 'normal' || crossesBoundary) {
      const parts: string[] = [];
      if (crossesBoundary) {
        parts.push(
          `crosses DST boundary from ${describeOffset(prevOffset!)} to ${describeOffset(resolved.offsetMs)}`
          + (prevStart ? ` (previous ${isoWall(parseWall(prevStart))})` : ''),
        );
      }
      if (resolved.kind === 'gap') {
        parts.push(`${isoWall(parseWall(occ.effectiveStart))} does not exist in ${zone} (spring-forward gap); the instant resolves forward`);
      }
      if (resolved.kind === 'overlap') {
        parts.push(`${isoWall(parseWall(occ.effectiveStart))} occurs twice in ${zone} (fall-back); the earlier instant is chosen`);
      }
      notes.push({
        occurrenceUid: occ.uid,
        start: occ.effectiveStart,
        prevOffsetMs: prevOffset,
        offsetMs: resolved.offsetMs,
        kind: resolved.kind,
        crossesBoundary,
        message: parts.join('; '),
      });
    }
    prevOffset = resolved.offsetMs;
    prevStart = occ.effectiveStart;
  }
  return notes;
}

/** Gap/overlap classification for a single candidate wall time. */
export function classifyWall(w: Wall, zone: string): WallInstant {
  return wallToInstant(w, zone);
}
