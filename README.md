# Recurrence Rule Studio

Drag occurrences on a recurrence timeline as **one exception** or **this-and-all-following**,
without ever expanding the series into independent records.

## Run

```bash
npm install
npm run dev      # API on :4174, Vite UI on :4173
npm test         # 38 tests: engine, structured ops, DST, HTTP API
```

## Model (`src/shared`)

- `wall.ts` — wall-clock primitives. Recurrence math runs in local components
  (per-series zone); `wallToInstant` resolves absolute instants and classifies
  DST **gap / overlap / normal** by binary-searching the zone's offset step.
- `model.ts` — `RRule` (DAILY / WEEKLY / MONTHLY with COUNT or UNTIL, BYDAY,
  BYMONTHDAY incl. negative), `Rule` segments, exceptions, and expansion.
  Invalid monthly dates (BYMONTHDAY=31 in February) are **skipped**, never
  rolled forward. A series is a chain of segments ordered by `seq`.
- `operations.ts` — structured `Operation`s and their exact inverses:
  - **only this one** → one `exceptionUpsert`/`exceptionDelete` keyed by the
    original recurrence-id (replacement = moved; absent = EXDATE);
  - **this and following** → `truncateRule` (head ends one second before the
    dragged occurrence), `ruleAdd` (new segment anchored at that occurrence),
    `exceptionMove` for every tail exception, plus one exception for the drag.
    COUNT remainder and the original UNTIL are carried onto the new segment.
  Undo replays inverted ops — never a whole-collection snapshot.
- `dst.ts` — audits occurrences for offset crossings and gap/overlap times.

## Server (`src/server/index.ts`)

`GET /api/series/:id`, dry-run `POST …/preview`, persist `POST …/drags`
(intent + revision), generic `POST …/changes` (used for undo). Every mutation
requires the current `revision`; a stale write returns **409 with the current
payload** and the client keeps its drag intent to re-apply on the new revision.
`POST …/touch` simulates a concurrent writer.

## Client

The timeline shows predicted occurrences first; the scope switch re-runs
preview; Save carries the rule revision. On conflict the intent is retained and
re-anchored via `rebaseIntent` (owning segment re-resolved by identity).
