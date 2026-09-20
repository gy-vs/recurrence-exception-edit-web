import express from 'express';
import {fileURLToPath} from 'node:url';
import {Occurrence, Series, expandSeries, validateRule} from '../shared/model';
import {Change, DragRequest, applyChange, buildDragChange, cloneSeries} from '../shared/operations';
import {DstNote, auditDst} from '../shared/dst';
import {addMonths, parseWall, wallKey} from '../shared/wall';

type Stored = {series: Series};

// Seed data covers the tricky cases up front: DST transitions, invalid monthly
// dates, COUNT, UNTIL and pre-existing exceptions.
function seed(): Stored[] {
  return [
    {
      series: {
        id: 'standup',
        title: 'Daily stand-up',
        zone: 'America/New_York',
        revision: 1,
        rules: [
          {
            id: 'standup-1', seq: 1,
            dtstart: '20260301T090000',
            zone: 'America/New_York',
            rrule: {freq: 'DAILY', interval: 1},
            exceptions: [
              {recurrenceId: '20260305T090000', replacement: '20260305T140000'}, // pre-existing move
              {recurrenceId: '20260310T090000'}, // pre-existing cancellation
            ],
          },
        ],
      },
    },
    {
      series: {
        id: 'payday',
        title: 'Month-end payroll (31st)',
        zone: 'UTC',
        revision: 1,
        rules: [
          {
            id: 'payday-1', seq: 1,
            dtstart: '20260131T080000',
            zone: 'UTC',
            rrule: {freq: 'MONTHLY', interval: 1, byMonthDay: [31]},
            exceptions: [],
          },
        ],
      },
    },
    {
      series: {
        id: 'sprints',
        title: 'Sprint review (6 sessions)',
        zone: 'UTC',
        revision: 1,
        rules: [
          {
            id: 'sprints-1', seq: 1,
            dtstart: '20260907T150000',
            zone: 'UTC',
            rrule: {freq: 'WEEKLY', interval: 1, byWeekDay: ['MO'], count: 6},
            exceptions: [],
          },
        ],
      },
    },
    {
      series: {
        id: 'audits',
        title: 'Weekly audit (bounded)',
        zone: 'UTC',
        revision: 1,
        rules: [
          {
            id: 'audits-1', seq: 1,
            dtstart: '20260904T110000',
            zone: 'UTC',
            rrule: {freq: 'WEEKLY', interval: 1, byWeekDay: ['FR'], until: '20261127T110000'},
            exceptions: [],
          },
        ],
      },
    },
  ];
}

export type SeriesPayload = {
  series: Series;
  horizon: string;
  occurrences: Occurrence[];
  dst: DstNote[];
};

function defaultHorizon(series: Series): string {
  const earliest = series.rules.reduce((acc, r) => (r.dtstart < acc ? r.dtstart : acc), series.rules[0]?.dtstart ?? '20990101T000000');
  return wallKey(addMonths(parseWall(earliest), 30));
}

export function buildPayload(series: Series, horizon = defaultHorizon(series)): SeriesPayload {
  const occurrences = expandSeries(series, horizon);
  return {series, horizon, occurrences, dst: auditDst(occurrences, series.zone)};
}

function validateSeries(series: Series): string | null {
  if (!series.rules.length) return 'series has no rules';
  for (const rule of series.rules) {
    const err = validateRule(rule.rrule, rule.dtstart);
    if (err) return `rule ${rule.id}: ${err}`;
  }
  return null;
}

export function createApp(){
  const app = express();
  app.use(express.json({limit:'1mb'}));
  const store = new Map<string, Stored>(seed().map((s) => [s.series.id, s]));

  function summary(s: Series) {
    const {rules, ...rest} = s;
    return {...rest, ruleCount: rules.length};
  }

  app.get('/api/series', (_req, res) => {
    res.json([...store.values()].map((s) => summary(s.series)));
  });

  app.get('/api/series/:id', (req, res) => {
    const stored = store.get(req.params.id);
    if (!stored) return res.status(404).json({error: 'not_found'});
    const payload = buildPayload(stored.series, req.query.horizon ? String(req.query.horizon) : undefined);
    res.set('ETag', String(stored.series.revision)).json(payload);
  });

  // Dry-run: predicts the structured change and resulting occurrences without persisting.
  app.post('/api/series/:id/preview', (req, res) => {
    const stored = store.get(req.params.id);
    if (!stored) return res.status(404).json({error: 'not_found'});
    const revision = Number(req.body.revision);
    if (revision !== stored.series.revision) {
      return res.status(409).json({error: 'revision_conflict', current: buildPayload(stored.series)});
    }
    try {
      const intent = req.body.intent as DragRequest;
      const change = buildDragChange(stored.series, intent);
      const projected = cloneSeries(stored.series);
      applyChange(projected, change);
      const err = validateSeries(projected);
      const payload = buildPayload(projected);
      res.json({...payload, baseRevision: revision, change, diagnostics: err ? [err] : []});
    } catch (error) {
      res.status(400).json({error: 'invalid_intent', message: (error as Error).message});
    }
  });

  // Persist a drag by intent. The canonical change is rebuilt server-side from
  // the structured series, so the client never sends a denormalised expansion.
  app.post('/api/series/:id/drags', (req, res) => {
    const stored = store.get(req.params.id);
    if (!stored) return res.status(404).json({error: 'not_found'});
    const revision = Number(req.body.revision);
    if (revision !== stored.series.revision) {
      // Intent is preserved by the client; it calls /preview again with the
      // returned current revision to re-anchor.
      return res.status(409).json({error: 'revision_conflict', current: buildPayload(stored.series)});
    }
    try {
      const intent = req.body.intent as DragRequest;
      const change = buildDragChange(stored.series, intent);
      applyChange(stored.series, change);
      const err = validateSeries(stored.series);
      if (err) return res.status(400).json({error: 'invalid_result', message: err});
      stored.series.revision += 1;
      res.json({...buildPayload(stored.series), appliedChange: change});
    } catch (error) {
      res.status(400).json({error: 'invalid_intent', message: (error as Error).message});
    }
  });

  // Persist an arbitrary structured change (used for undo: the client sends
  // the inverted ops, never a whole replacement collection).
  app.post('/api/series/:id/changes', (req, res) => {
    const stored = store.get(req.params.id);
    if (!stored) return res.status(404).json({error: 'not_found'});
    const revision = Number(req.body.revision);
    if (revision !== stored.series.revision) {
      return res.status(409).json({error: 'revision_conflict', current: buildPayload(stored.series)});
    }
    const change = req.body.change as Change;
    if (!change || !Array.isArray(change.ops) || !change.ops.length) {
      return res.status(400).json({error: 'empty_change'});
    }
    try {
      applyChange(stored.series, change);
      const err = validateSeries(stored.series);
      if (err) return res.status(400).json({error: 'invalid_result', message: err});
      stored.series.revision += 1;
      res.json(buildPayload(stored.series));
    } catch (error) {
      res.status(400).json({error: 'invalid_change', message: (error as Error).message});
    }
  });

  // Test-only hook to simulate a concurrent writer bumping the revision.
  app.post('/api/series/:id/touch', (req, res) => {
    const stored = store.get(req.params.id);
    if (!stored) return res.status(404).json({error: 'not_found'});
    stored.series.title = req.body?.title ? String(req.body.title) : stored.series.title;
    stored.series.revision += 1;
    res.json(buildPayload(stored.series));
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
