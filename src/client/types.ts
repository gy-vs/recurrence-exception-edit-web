export type {Series, Rule, RRule, Exception, Occurrence} from '../shared/model';
export type {DstNote} from '../shared/dst';

export type SeriesPayload = {
  series: import('../shared/model').Series;
  horizon: string;
  occurrences: import('../shared/model').Occurrence[];
  dst: import('../shared/dst').DstNote[];
};
