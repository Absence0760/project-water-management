// A catchment's figures in words, and their order (WP-2.14): the project
// list's outcome columns (which took in the team portfolio page, issue #176),
// the teams list and the team page. Every status is written out as text as
// well as coloured, so colour is never the only signal; every unknown says
// why. Pure, so it is unit-tested apart from the pages.
import type { PortfolioEwrStatus, PortfolioProject, PortfolioThresholds } from '#lib/api/types.js';
import { dateAge, sharedWindowText, windowText, type DataEnd } from '#lib/format/age.js';
import { fmtNum } from '#lib/format/number.js';

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
	return t.source === 'team' ? 'These are the team’s own thresholds.' : 'These are the default thresholds: a provisional default, not yet confirmed by the catchment’s hydrologist.';
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

/** The project list's status column (issue #558): irrigation supplied over the source run, not the EWR. */
export const IRRIGATION_LABEL = 'Irrigation supplied';

/** The irrigation traffic light's rule (backend portfolio/status.ts IRRIGATION_THRESHOLDS; provisional, no team setting yet). */
export const IRRIGATION_RULE = 'green from 95 % of demand supplied over the run, amber from 80 %, red below';

/** Why a run's use share and dam levels aren't shown (PortfolioProject.figuresWithheld, #523 I). */
const WITHHELD_WHY = 'the run caps use at, or scales demand to, the registered water volumes, which this project shows to its editors and owners only';

/**
 * Why a row's figures are withheld, short enough for the line under its pill
 * (the project list) or its Lowest dam (the team page), so each row says it
 * once; null when nothing is withheld.
 */
export const withheldText = (p: Pick<PortfolioProject, 'figuresWithheld'>): string | null =>
	p.figuresWithheld ? 'Uses registered volumes, shown to editors and owners only' : null;

/** "3 of 5 units below 95%", or null when none is (or the figure is unknown). */
export function irrigationUnitsText(p: Pick<PortfolioProject, 'irrigation'>): string | null {
	const r = p.irrigation;
	return r.status !== 'unknown' && r.unitsBelow && r.units ? `${r.unitsBelow} of ${plural(r.units, 'unit')} below 95%` : null;
}

/**
 * "Red: 72.0% supplied, 3 of 5 units below 95%", "Green: 98.1% supplied", or
 * "Unknown: <why>" (issue #558). The share is over the source run's whole
 * record, as the workspace's Irrigation supplied card. `short` leaves the
 * units out (the list's pill, which says them on the line under it).
 */
export function irrigationText(p: Pick<PortfolioProject, 'irrigation'>, short = false): string {
	const r = p.irrigation;
	if (r.status === 'unknown' || r.fractionSupplied == null) {
		if (r.reason === 'withheld') return short ? 'Withheld' : `Withheld: ${WITHHELD_WHY}`;
		const why = r.reason === 'no-units' ? 'no hydrological units in the run' : r.reason === 'no-demand' ? 'no irrigation demand in the run' : 'no run yet';
		return `Unknown: ${why}`;
	}
	const head = `${STATUS_LABEL[r.status]}: ${fmtNum(r.fractionSupplied * 100, 1)}% supplied`;
	const units = irrigationUnitsText(p);
	return units && !short ? `${head}, ${units}` : head;
}

/** Where the figures come from, in words. */
export function sourceText(p: Pick<PortfolioProject, 'source' | 'publishedAt' | 'newerRun'>): string {
	if (p.source === 'published') return p.newerRun ? 'Published run (a newer run is not published)' : 'Published run';
	if (p.source === 'run') return 'Latest run, not published';
	return 'Not run yet';
}

/** The figures' last day and its age on the project's today; null without figures. */
export const figuresEnd = (p: Pick<PortfolioProject, 'figuresUntil' | 'figuresAgeDays'>): DataEnd | null =>
	p.figuresUntil && p.figuresAgeDays != null ? { end: p.figuresUntil, age: p.figuresAgeDays } : null;

/** How old the figures are: "to 29 Dec 2023 (2 years ago)"; null without figures. */
export function ageText(p: Pick<PortfolioProject, 'figuresUntil' | 'figuresAgeDays'>): string | null {
	const e = figuresEnd(p);
	return e ? `to ${dateAge(e.end, Math.max(0, e.age))}` : null;
}

/**
 * "2 of 14 hydrological units short this week", or "… short in the week to
 * 31 Dec 2024" once the figures are stale (the week is the figures' last
 * one, not the calendar's); null when unknown (the caller says why).
 */
export function farmsShortText(p: Pick<PortfolioProject, 'farmsShort7' | 'farmCount' | 'figuresUntil' | 'figuresAgeDays'>): string | null {
	if (p.farmsShort7 == null) return null;
	if (!p.farmCount) return 'No hydrological units';
	return `${p.farmsShort7} of ${plural(p.farmCount, 'hydrological unit')} short ${windowText(figuresEnd(p), 'this week', 'in the week to {date}')}`;
}

/** "in the last 30 days", or "in the 30 days to 31 Dec 2024" once the figures are stale. */
export const last30Text = (p: Pick<PortfolioProject, 'figuresUntil' | 'figuresAgeDays'>): string =>
	windowText(figuresEnd(p), 'in the last 30 days', 'in the 30 days to {date}');

type Ends = readonly Pick<PortfolioProject, 'figuresUntil' | 'figuresAgeDays'>[];

/** The EWR column's or total's label over several catchments: "EWR, last 30 days", "EWR, 30 days to 31 Dec 2024". */
export const ewrWindowLabel = (rows: Ends): string =>
	sharedWindowText(rows.map(figuresEnd), 'EWR, last 30 days', 'EWR, 30 days to {date}', 'EWR, last 30 days of figures');

/** Why the farm counts are unknown. */
export function farmsUnknownText(p: Pick<PortfolioProject, 'source'>): string {
	return p.source === 'published' ? 'Unknown: publish again to count them' : 'Unknown until a run is published';
}

/** "Kareebos 18 %", "No dams", "Withheld" (`withheldText` says why), or why it is unknown. */
export function damText(p: Pick<PortfolioProject, 'lowestDamPct' | 'damsKnown' | 'figuresWithheld'>): string {
	if (!p.damsKnown) return 'Unknown until a run is published';
	if (p.figuresWithheld) return 'Withheld';
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

/** The keys comparePortfolio sorts by (the project list names them, projects/grouping.ts). */
export type PortfolioSortKey = 'status' | 'supply' | 'name' | 'age' | 'farms' | 'dam';
export type SortDir = 'asc' | 'desc';
export interface PortfolioSort {
	key: PortfolioSortKey;
	dir: SortDir;
}

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
		case 'supply':
			// Within a colour, less supplied is worse.
			return STATUS_RANK[p.irrigation.status] * 1000 - (1 - (p.irrigation.fractionSupplied ?? 1)) * 100;
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


/** Counts per status, for the summary line above the table: the EWR's (the teams pages), or irrigation's (the project list, issue #558). */
export function statusCounts(rows: readonly PortfolioProject[], of: 'ewr' | 'irrigation' = 'ewr'): Record<PortfolioEwrStatus, number> {
	const out: Record<PortfolioEwrStatus, number> = { red: 0, amber: 0, green: 0, unknown: 0 };
	for (const r of rows) out[r[of].status]++;
	return out;
}

/**
 * Where "N units short this week" links: the run's curtailment on Units &
 * supply over the last 7 days (the reporting-window picker, #44; the page
 * since issue #17). Both count the 7 days to the run's last day of recorded
 * rain (reportWindow.ts runDataUntil, the publication's recent.ts), so the
 * link opens the same week it counted. `base` is the app's base path.
 */
export function curtailmentHref(p: Pick<PortfolioProject, 'id' | 'sourceRunId'>, base = ''): string {
	return `${base}/projects/${p.id}?tab=supply&run=${p.sourceRunId}&window=last7#res-curtailment`;
}

// ---------------------------------------------------------------------------
// Totals: the teams list, the team page and the project list's header line
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
	/** The irrigation statuses (the project list's, issue #558). */
	irrigation: Record<PortfolioEwrStatus, number>;
	alertsFiring: number;
	/** Catchments whose figures are over 7 days old. */
	stale: number;
}

export function portfolioTotals(rows: readonly PortfolioProject[]): PortfolioTotals {
	let alertsFiring = 0;
	let stale = 0;
	for (const r of rows) {
		alertsFiring += r.alertsFiring;
		if (r.stale) stale++;
	}
	return { catchments: rows.length, counts: statusCounts(rows), irrigation: statusCounts(rows, 'irrigation'), alertsFiring, stale };
}
