// The team portfolio page's wording and sorting (WP-2.14, docs/ui.md §
// Portfolio). Every status is written out as text as well as coloured, so
// colour is never the only signal; every unknown says why. Pure, so it is
// unit-tested apart from the page.
import type { PortfolioEwrStatus, PortfolioProject } from '$lib/api/types';
import { fmtDay, fmtNum } from '$lib/format/number';

export const STATUS_LABEL: Record<PortfolioEwrStatus, string> = { red: 'Red', amber: 'Amber', green: 'Green', unknown: 'Unknown' };

const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

/** "Red: EWR not met 9 of 30 days", "Green: EWR met all 30 days", or "Unknown: <why>". */
export function ewrText(p: Pick<PortfolioProject, 'ewr'>): string {
	const e = p.ewr;
	if (e.status === 'unknown') {
		const why =
			e.reason === 'no-ewr'
				? 'no EWR set in the run'
				: e.reason === 'no-series'
					? 'the run has no EWR record; run it again'
					: 'no run yet';
		return `Unknown: ${why}`;
	}
	const label = STATUS_LABEL[e.status];
	if (!e.daysNotMet30) return `${label}: EWR met all ${e.days30} days`;
	return `${label}: EWR not met ${e.daysNotMet30} of ${e.days30} days`;
}

/** Where the figures come from, in words. */
export function sourceText(p: Pick<PortfolioProject, 'source' | 'publishedAt' | 'newerRun'>): string {
	if (p.source === 'published') return p.newerRun ? 'Published run (a newer run is not published)' : 'Published run';
	if (p.source === 'run') return 'Latest run, not published';
	return 'Not run yet';
}

/** How old the figures are: "to 29 Dec 2023, 1,002 days ago"; null without figures. */
export function ageText(p: Pick<PortfolioProject, 'figuresUntil' | 'figuresAgeDays'>): string | null {
	if (!p.figuresUntil || p.figuresAgeDays == null) return null;
	const d = p.figuresAgeDays;
	const ago = d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${fmtNum(d)} days ago`;
	return `to ${fmtDay(p.figuresUntil)}, ${ago}`;
}

/** "2 of 12 farms short this week"; null when unknown (the caller says why). */
export function farmsShortText(p: Pick<PortfolioProject, 'farmsShort7' | 'farmCount'>): string | null {
	if (p.farmsShort7 == null) return null;
	if (!p.farmCount) return 'No farms';
	return `${p.farmsShort7} of ${plural(p.farmCount, 'farm')} short this week`;
}

/** Why the farm counts are unknown. */
export function farmsUnknownText(p: Pick<PortfolioProject, 'source'>): string {
	return p.source === 'published' ? 'Unknown: publish again to count them' : 'Unknown until a run is published';
}

/** "Kareebos 18 %", "No farm dams", or why it is unknown. */
export function damText(p: Pick<PortfolioProject, 'lowestDamPct' | 'damsKnown'>): string {
	if (!p.damsKnown) return 'Unknown until a run is published';
	if (!p.lowestDamPct) return 'No farm dams';
	return `${p.lowestDamPct.nodeName} ${fmtNum(p.lowestDamPct.pct * 100)} %`;
}

export function restrictionText(p: Pick<PortfolioProject, 'restriction'>): string {
	const r = p.restriction;
	if (!r) return 'Not published';
	if (r.level === 'none') return 'None';
	const level = r.level === 'advisory' ? 'Advisory' : 'Restricted';
	return r.pct == null ? level : `${level} · ${fmtNum(r.pct, 2, true)} %`;
}

/** "None" or "2 firing" (WP-2.13: alert_event rows firing now). */
export function alertsText(p: Pick<PortfolioProject, 'alertsFiring'>): string {
	return p.alertsFiring > 0 ? `${fmtNum(p.alertsFiring)} firing` : 'None';
}

/** "No feeds", "2 feeds OK", "1 of 3 feeds failing or stale". */
export function feedsText(p: Pick<PortfolioProject, 'feeds'>): string {
	const f = p.feeds;
	if (!f.total) return 'No feeds';
	if (f.failing) return `${f.failing} of ${plural(f.total, 'feed')} failing or stale`;
	if (f.ok === f.total) return `${plural(f.total, 'feed')} OK`;
	return `${f.ok} of ${plural(f.total, 'feed')} OK, the rest waiting or off`;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type PortfolioSortKey = 'status' | 'name' | 'age' | 'farms' | 'dam';
export type SortDir = 'asc' | 'desc';
export interface PortfolioSort {
	key: PortfolioSortKey;
	dir: SortDir;
}

export const SORT_LABELS: Record<PortfolioSortKey, string> = {
	status: 'EWR status (worst first)',
	name: 'Catchment name',
	age: 'Figures age (oldest first)',
	farms: 'Farms short this week (most first)',
	dam: 'Lowest dam (lowest first)'
};

/** The default: worst EWR status first. */
export const DEFAULT_SORT: PortfolioSort = { key: 'status', dir: 'asc' };

/** Worst first: red, amber, then unknown (it may hide a red), then green. */
const STATUS_RANK: Record<PortfolioEwrStatus, number> = { red: 0, amber: 1, unknown: 2, green: 3 };

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * The value each key sorts on, "worst" smallest, so ascending = worst first.
 * Unknowns (null) always go last in either direction.
 */
function value(p: PortfolioProject, key: PortfolioSortKey): number | null {
	switch (key) {
		case 'status':
			// Within a colour, more days not met is worse.
			return STATUS_RANK[p.ewr.status] * 1000 - (p.ewr.fraction30 ?? 0) * 100;
		case 'age':
			return p.figuresAgeDays == null ? null : -p.figuresAgeDays;
		case 'farms':
			return p.farmsShort7 == null ? null : -p.farmsShort7;
		case 'dam':
			return p.lowestDamPct ? p.lowestDamPct.pct : null;
		case 'name':
			return 0;
	}
}

export function sortPortfolio(rows: readonly PortfolioProject[], { key, dir }: PortfolioSort): PortfolioProject[] {
	const sign = dir === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		if (key !== 'name') {
			const va = value(a, key);
			const vb = value(b, key);
			if (va === null || vb === null) {
				if (va !== vb) return va === null ? 1 : -1;
			} else if (va !== vb) return sign * (va - vb);
			return collator.compare(a.name, b.name);
		}
		return sign * collator.compare(a.name, b.name);
	});
}

/** A click on a column heading: the same key flips direction, a new key starts ascending (worst first). */
export function nextSort(cur: PortfolioSort, key: PortfolioSortKey): PortfolioSort {
	return cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
}

/** Read `?sort=` and `?dir=`, falling back to the default. */
export function parseSort(sort: string | null, dir: string | null): PortfolioSort {
	const key = sort && Object.hasOwn(SORT_LABELS, sort) ? (sort as PortfolioSortKey) : DEFAULT_SORT.key;
	return { key, dir: dir === 'desc' ? 'desc' : 'asc' };
}

/** Counts per status, for the summary line above the table. */
export function statusCounts(rows: readonly PortfolioProject[]): Record<PortfolioEwrStatus, number> {
	const out: Record<PortfolioEwrStatus, number> = { red: 0, amber: 0, green: 0, unknown: 0 };
	for (const r of rows) out[r.ewr.status]++;
	return out;
}

/**
 * Where "N farms short this week" links: the run's curtailment on the Runs
 * tab over the last 7 days (the reporting-window picker, #44). `base` is the
 * app's base path.
 */
export function curtailmentHref(p: Pick<PortfolioProject, 'id' | 'sourceRunId'>, base = ''): string {
	return `${base}/projects/${p.id}?tab=runs&run=${p.sourceRunId}&window=last7#res-curtailment`;
}
