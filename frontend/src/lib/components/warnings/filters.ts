// The Warnings page's filters across every row (issue #611): the data checks'
// periods, the problems from elsewhere and the run's warnings, each seen
// through one shape (FacetRow) so one set of filters, in the URL, narrows them
// all, and each chip counts what it would show under the other filters.
//   source=  checks | model | settings | feeds | data | runs | run   (all)
//   status=  open | fixed | kept | all                               (open)
//   sev=     check | note                                            (both)
//   area=    data | rain | calibration | model | feeds | runs        (all)
//   series=  a record's series id                                    (all)
//   q=       words to find, in any order, in a row's text            (none)
// The data checks' own `check=` (the kind of check) stays theirs (items.ts).
import { AREAS, SOURCE_FILTERS, type Area, type SourceFilter } from './problems';

/** A row's state, as the Status filter groups it: open; fixed or handled (a decision, a fix saved, or the run's default); kept. */
export type RowState = 'open' | 'fixed' | 'kept';
export type StateFilter = RowState | 'all';
export const STATE_FILTERS: readonly StateFilter[] = ['open', 'fixed', 'kept', 'all'];
export const STATE_LABEL: Record<StateFilter, string> = { open: 'Open', fixed: 'Fixed or handled', kept: 'Kept', all: 'All' };
export type Severity = 'check' | 'note';
export const SEVERITY_LABEL: Record<Severity, string> = { check: 'To check', note: 'Notes' };

export interface FacetRow {
	source: Exclude<SourceFilter, 'all'>;
	state: RowState;
	severity: Severity;
	area: Area;
	record: string | null;
	/** Everything the row says, for the search. */
	text: string;
}

export interface PageFilters {
	source: SourceFilter;
	status: StateFilter;
	sev: Severity | null;
	area: Area | null;
	series: string | null;
	q: string;
}

const pick = <T extends string>(v: string | null, all: readonly T[]): T | null => (v && (all as readonly string[]).includes(v) ? (v as T) : null);

/** The filters a URL asks for; an unknown value is no filter. Status defaults to open. */
export function parsePageFilters(q: Pick<URLSearchParams, 'get'>): PageFilters {
	return {
		source: pick(q.get('source'), SOURCE_FILTERS) ?? 'all',
		status: pick(q.get('status'), STATE_FILTERS) ?? 'open',
		sev: pick(q.get('sev'), ['check', 'note'] as const),
		area: pick(q.get('area'), AREAS),
		series: q.get('series') || null,
		q: (q.get('q') ?? '').trim()
	};
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** Whether `r` passes the filters, leaving one out (`skip`) for that filter's own chip counts. */
export function passes(r: FacetRow, f: PageFilters, skip?: keyof PageFilters): boolean {
	if (skip !== 'source' && f.source !== 'all' && r.source !== f.source) return false;
	if (skip !== 'status' && f.status !== 'all' && r.state !== f.status) return false;
	if (skip !== 'sev' && f.sev && r.severity !== f.sev) return false;
	if (skip !== 'area' && f.area && r.area !== f.area) return false;
	if (skip !== 'series' && f.series && r.record !== f.series) return false;
	if (skip !== 'q' && f.q) {
		const t = r.text.toLowerCase();
		if (!words(f.q).every((w) => t.includes(w))) return false;
	}
	return true;
}

/** Each chip's count: the rows it would show under the other filters. */
export function facetCounts(rows: readonly FacetRow[], f: PageFilters) {
	const count = <K extends string>(skip: keyof PageFilters, key: (r: FacetRow) => K) => {
		const m = new Map<K | 'all', number>();
		for (const r of rows) {
			if (!passes(r, f, skip)) continue;
			m.set(key(r), (m.get(key(r)) ?? 0) + 1);
			m.set('all', (m.get('all') ?? 0) + 1);
		}
		return (k: K | 'all') => m.get(k) ?? 0;
	};
	return {
		source: count('source', (r) => r.source),
		status: count('status', (r) => r.state),
		sev: count('sev', (r) => r.severity),
		area: count('area', (r) => r.area)
	};
}
