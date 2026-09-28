// The team portfolio page's wording and sorting (WP-2.14, docs/ui.md §
// Portfolio). Every status is written out as text as well as coloured, so
// colour is never the only signal; every unknown says why. Pure, so it is
// unit-tested apart from the page.
import type { PortfolioEwrStatus, PortfolioProject, PortfolioThresholds } from '$lib/api/types';
import { fmtDay, fmtNum } from '$lib/format/number';

export const STATUS_LABEL: Record<PortfolioEwrStatus, string> = { red: 'Red', amber: 'Amber', green: 'Green', unknown: 'Unknown' };

/** A cut-off as the page writes it: "5 %", "2.5 %". */
export const pctText = (n: number): string => `${fmtNum(n, 2, true)} %`;

/**
 * The rule the statuses were judged by, and whose it is: "green when it was
 * not met on under 5 % of them, amber under 20 %, red otherwise".
 */
export function thresholdsRule(t: Pick<PortfolioThresholds, 'green' | 'amber'>): string {
	return `green when it was not met on under ${pctText(t.green)} of them, amber under ${pctText(t.amber)}, red otherwise`;
}

/** Whose thresholds these are: the team's own, or the defaults still waiting for the hydrologist's sign-off (D11). */
export function thresholdsSource(t: Pick<PortfolioThresholds, 'source'>): string {
	return t.source === 'team' ? 'These are the team’s own thresholds.' : 'These are the default thresholds, still to be confirmed by the hydrologist.';
}

/**
 * Why the team page's threshold form can't be saved, or null: both 0–100 %,
 * green below amber (the API's rule, teams/settings.ts). Empty inputs are
 * NaN (a number input's valueAsNumber).
 */
export function thresholdsError(green: number, amber: number): string | null {
	if (!Number.isFinite(green) || !Number.isFinite(amber)) return 'Enter both cut-offs as numbers.';
	if (green < 0 || green > 100 || amber < 0 || amber > 100) return 'Each cut-off is a percentage from 0 to 100.';
	if (green >= amber) return 'The green cut-off must be below the amber one.';
	return null;
}

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

/** How old the figures are: "to 29 Dec 2023, 1 002 days ago"; null without figures. */
export function ageText(p: Pick<PortfolioProject, 'figuresUntil' | 'figuresAgeDays'>): string | null {
	if (!p.figuresUntil || p.figuresAgeDays == null) return null;
	const d = p.figuresAgeDays;
	const ago = d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${fmtNum(d)} days ago`;
	return `to ${fmtDay(p.figuresUntil)}, ${ago}`;
}

/** "2 of 14 farms short this week"; null when unknown (the caller says why). */
export function farmsShortText(p: Pick<PortfolioProject, 'farmsShort7' | 'farmCount'>): string | null {
	if (p.farmsShort7 == null) return null;
	if (!p.farmCount) return 'No units';
	return `${p.farmsShort7} of ${plural(p.farmCount, 'unit')} short this week`;
}

/** Why the farm counts are unknown. */
export function farmsUnknownText(p: Pick<PortfolioProject, 'source'>): string {
	return p.source === 'published' ? 'Unknown: publish again to count them' : 'Unknown until a run is published';
}

/** "Kareebos 18 %", "No farm dams", or why it is unknown. */
export function damText(p: Pick<PortfolioProject, 'lowestDamPct' | 'damsKnown'>): string {
	if (!p.damsKnown) return 'Unknown until a run is published';
	if (!p.lowestDamPct) return 'No dams';
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
	farms: 'Units short this week (most first)',
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

export function sortPortfolio(rows: readonly PortfolioProject[], sort: PortfolioSort): PortfolioProject[] {
	return [...rows].sort(comparePortfolio(sort));
}

/** The portfolio's order as a comparator (the project list sorts its rows by the same rule). */
export function comparePortfolio({ key, dir }: PortfolioSort): (a: PortfolioProject, b: PortfolioProject) => number {
	const sign = dir === 'asc' ? 1 : -1;
	return (a, b) => {
		if (key !== 'name') {
			const va = value(a, key);
			const vb = value(b, key);
			if (va === null || vb === null) {
				if (va !== vb) return va === null ? 1 : -1;
			} else if (va !== vb) return sign * (va - vb);
			return collator.compare(a.name, b.name);
		}
		return sign * collator.compare(a.name, b.name);
	};
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
 * Where "N units short this week" links: the run's curtailment on Units &
 * supply over the last 7 days (the reporting-window picker, #44; the page
 * since issue #17). `base` is the app's base path.
 */
export function curtailmentHref(p: Pick<PortfolioProject, 'id' | 'sourceRunId'>, base = ''): string {
	return `${base}/projects/${p.id}?tab=supply&run=${p.sourceRunId}&window=last7#res-curtailment`;
}

// ---------------------------------------------------------------------------
// Totals: the teams list, the team page and the portfolio's header
// ---------------------------------------------------------------------------

/** Worst first, the order every status summary lists them in. */
export const STATUS_ORDER: readonly PortfolioEwrStatus[] = ['red', 'amber', 'unknown', 'green'];

/** "1 red, 2 amber, 4 green" (worst first, zero counts left out); "" when there are none. */
export function statusSummary(counts: Record<PortfolioEwrStatus, number>): string {
	return STATUS_ORDER.filter((s) => counts[s])
		.map((s) => `${fmtNum(counts[s])} ${STATUS_LABEL[s].toLowerCase()}`)
		.join(', ');
}

/** A team's catchments added up. */
export interface PortfolioTotals {
	catchments: number;
	counts: Record<PortfolioEwrStatus, number>;
	/** Farms short this week, over the catchments whose count is known; null when no count is known. */
	farmsShort7: number | null;
	/** The farms those counts are out of. */
	farmsCounted: number;
	alertsFiring: number;
	/** Catchments whose figures are over 7 days old. */
	stale: number;
	/** The newest run of any catchment (ISO timestamp), or null when none has run. */
	lastRunAt: string | null;
}

export function portfolioTotals(rows: readonly PortfolioProject[]): PortfolioTotals {
	let farmsShort7: number | null = null;
	let farmsCounted = 0;
	let alertsFiring = 0;
	let stale = 0;
	let lastRunAt: string | null = null;
	for (const r of rows) {
		if (r.farmsShort7 != null) {
			farmsShort7 = (farmsShort7 ?? 0) + r.farmsShort7;
			farmsCounted += r.farmCount;
		}
		alertsFiring += r.alertsFiring;
		if (r.stale) stale++;
		if (r.lastRunAt && (!lastRunAt || Date.parse(r.lastRunAt) > Date.parse(lastRunAt))) lastRunAt = r.lastRunAt;
	}
	return { catchments: rows.length, counts: statusCounts(rows), farmsShort7, farmsCounted, alertsFiring, stale, lastRunAt };
}

/** "2 of 14 farms", "No farms", or null when no catchment's count is known (the caller says why). */
export function farmsShortTotalText(t: Pick<PortfolioTotals, 'farmsShort7' | 'farmsCounted'>): string | null {
	if (t.farmsShort7 == null) return null;
	if (!t.farmsCounted) return 'No units';
	return `${fmtNum(t.farmsShort7)} of ${plural(t.farmsCounted, 'unit')}`;
}
