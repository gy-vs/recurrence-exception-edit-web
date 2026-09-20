// Wall-clock time primitives. All recurrence math happens in "wall time" (local
// components in the series' time zone); conversion to absolute instants only
// happens for display and for DST diagnostics, per RFC 5545 §3.3.5/§3.8.5.

export type Wall = {
  y: number;
  mo: number; // 1-12
  d: number; // 1-31
  h: number; // 0-23
  mi: number; // 0-59
  s: number; // 0-59
};

export function wall(w: Partial<Wall> & { y: number; mo: number; d: number }): Wall {
  return { h: 0, mi: 0, s: 0, ...w };
}

export function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/** Stable, lexicographically sortable key in local components. */
export function wallKey(w: Wall): string {
  return `${pad(w.y, 4)}${pad(w.mo)}${pad(w.d)}T${pad(w.h)}${pad(w.mi)}${pad(w.s)}`;
}

export function parseWall(value: string): Wall {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!m) throw new Error(`bad wall value: ${value}`);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
}

export function isoWall(w: Wall): string {
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
}

export function equalWall(a: Wall, b: Wall): boolean {
  return wallKey(a) === wallKey(b);
}

export function compareWall(a: Wall, b: Wall): number {
  return wallKey(a) < wallKey(b) ? -1 : wallKey(a) > wallKey(b) ? 1 : 0;
}

export function dayOfWeek(w: Wall): number {
  // 0 = Sunday .. 6 = Saturday
  return new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
}

export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function norm(y: number, mo: number, d: number, h: number, mi: number, s: number): Wall {
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const dt = new Date(t);
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    h: dt.getUTCHours(),
    mi: dt.getUTCMinutes(),
    s: dt.getUTCSeconds(),
  };
}

export function addSeconds(w: Wall, seconds: number): Wall {
  return norm(w.y, w.mo, w.d, w.h, w.mi, w.s + seconds);
}

export function addDays(w: Wall, days: number): Wall {
  return norm(w.y, w.mo, w.d + days, w.h, w.mi, w.s);
}

export function addMonths(w: Wall, months: number): Wall {
  const total = (w.y * 12 + (w.mo - 1)) + months;
  return norm(Math.floor(total / 12), (total % 12) + 1, w.d, w.h, w.mi, w.s);
}

/**
 * Calendar-month stepping WITHOUT day rollover: returns the target year/month
 * reached by adding whole months from (y, mo). Enumerating days 1..daysInMonth
 * of the returned month is what makes BYMONTHDAY=31 skip February instead of
 * rolling onto March.
 */
export function addCalendarMonth(y: number, mo: number, months: number): { y: number; mo: number } {
  const total = y * 12 + (mo - 1) + months;
  return {y: Math.floor(total / 12), mo: (total % 12) + 1};
}

/** The last representable wall time strictly before `w` (used for UNTIL bounds). */
export function previousSecond(w: Wall): Wall {
  return addSeconds(w, -1);
}

// --- zone conversion -------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZoneName: 'longOffset',
    });
    dtfCache.set(zone, f);
  }
  return f;
}

function partMap(instant: Date, zone: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of zoneFormatter(zone).formatToParts(instant)) {
    if (p.type !== 'literal') out.set(p.type, p.value);
  }
  return out;
}

/** UTC offset in milliseconds in effect at an absolute instant in `zone`. */
export function offsetMsAt(zone: string, instantMs: number): number {
  const parts = partMap(new Date(instantMs), zone);
  const raw = parts.get('timeZoneName') ?? '';
  // Shapes: "GMT", "GMT-05:00", "GMT+05:30", sometimes "GMT+8"
  const m = /^GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(raw);
  if (!m || !m[1]) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((+m[2] * 60) + (+(m[3] ?? 0))) * 60_000;
}

export function instantToWall(instantMs: number, zone: string): Wall {
  const p = partMap(new Date(instantMs), zone);
  return {
    y: +(p.get('year') ?? 0),
    mo: +(p.get('month') ?? 1),
    d: +(p.get('day') ?? 1),
    h: (+(p.get('hour') ?? 0)) % 24,
    mi: +(p.get('minute') ?? 0),
    s: +(p.get('second') ?? 0),
  };
}

export type WallInstant = {
  instantMs: number;
  offsetMs: number;
  /**
   * - normal: wall time exists exactly once
   * - overlap: wall time exists twice (fall-back); the EARLIER instant is used
   *   (RFC 5545 transition rule — earlier offset wins)
   * - gap: wall time does not exist (spring-forward)
   */
  kind: 'normal' | 'overlap' | 'gap';
};

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * Locate the single offset transition instant inside [lo, hi], if any, by
 * binary-searching a step discontinuity of offsetMsAt to minute precision.
 */
function findTransition(zone: string, lo: number, hi: number): number | null {
  const oLo = offsetMsAt(zone, lo);
  if (oLo === offsetMsAt(zone, hi)) return null;
  while (hi - lo > MINUTE) {
    const mid = Math.floor((lo + hi) / 2 / MINUTE) * MINUTE;
    if (offsetMsAt(zone, mid) === oLo) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Resolve a wall time in `zone` to an absolute instant.
 *
 * Instant I renders the requested wall components when `I - offset(I) ==
 * guess`. An offset transition near the guess is located exactly; its two
 * plateaus can each contribute one matching instant:
 *  - one match: normal
 *  - two matches (fall-back, offset grows): overlap, the earlier instant wins
 *  - zero matches (spring-forward, offset shrinks): gap; resolve forward under
 *    the pre-transition offset so the instant lands after the jump
 */
export function wallToInstant(w: Wall, zone: string): WallInstant {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

  // No zone schedules two transitions within ~24h.
  const lo = guess - 25 * HOUR;
  const hi = guess + 25 * HOUR;
  const transition = findTransition(zone, lo, hi);

  if (transition === null) {
    const offset = offsetMsAt(zone, guess);
    return {instantMs: guess - offset, offsetMs: offset, kind: 'normal'};
  }
  const preOffset = offsetMsAt(zone, transition - MINUTE);
  const postOffset = offsetMsAt(zone, transition + MINUTE);
  const early = guess - preOffset;
  const late = guess - postOffset;
  const onPre = early < transition;
  const onPost = late >= transition;

  if (onPre && onPost) {
    return {instantMs: early, offsetMs: preOffset, kind: 'overlap'};
  }
  if (!onPre && !onPost) {
    // early is computed with the pre offset; report that applied offset.
    return {instantMs: early, offsetMs: preOffset, kind: 'gap'};
  }
  if (onPre) return {instantMs: early, offsetMs: preOffset, kind: 'normal'};
  return {instantMs: late, offsetMs: postOffset, kind: 'normal'};
}
