import type {SeriesPayload} from './types';
import type {Change, DragRequest} from '../shared/operations';

export type Conflict = {
  current: SeriesPayload;
  kind: 'drag' | 'change';
  intent?: DragRequest;
  change?: Change;
};

async function parse(res: Response) {
  const body = await res.json().catch(() => ({}));
  return {ok: res.ok, status: res.status, body};
}

export async function listSeries(): Promise<{id: string; title: string; revision: number; ruleCount: number}[]> {
  const res = await fetch('/api/series');
  return res.json();
}

export async function loadSeries(id: string): Promise<SeriesPayload> {
  const res = await fetch(`/api/series/${encodeURIComponent(id)}`);
  return res.json();
}

export async function previewDrag(id: string, revision: number, intent: DragRequest) {
  const res = await parse(
    await fetch(`/api/series/${encodeURIComponent(id)}/preview`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, intent}),
    }),
  );
  return res;
}

export async function saveDrag(id: string, revision: number, intent: DragRequest) {
  return parse(
    await fetch(`/api/series/${encodeURIComponent(id)}/drags`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, intent}),
    }),
  );
}

export async function saveChange(id: string, revision: number, change: Change) {
  return parse(
    await fetch(`/api/series/${encodeURIComponent(id)}/changes`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, change}),
    }),
  );
}

export async function touch(id: string): Promise<SeriesPayload> {
  const res = await fetch(`/api/series/${encodeURIComponent(id)}/touch`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
  return res.json();
}
