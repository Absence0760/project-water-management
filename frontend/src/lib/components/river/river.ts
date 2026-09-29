// River & reserve (issue #17, option A · Outcomes): which run the page shows,
// the run it is compared with, its three KPI tiles and the context line. The
// panels themselves are the ones that were Runs &
// results' River & Reserve group, moved here unchanged (docs/ui.md § River &
// reserve); their `#res-…` ids moved with them, so an old
// `?tab=runs&run=…#res-reserve` link is sent here (links.ts riverAnchor).
import { metricDelta, type MetricDelta, type RunSummary } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';
import type { NavGroup } from '$lib/components/common/sectionNav';
import type { MetricSpec } from '$lib/components/compare/delta';
import { ewrNotMet } from '$lib/components/ewr/notMet';
import { headlines } from '$lib/components/overview/latestRun';
import { fmtNum } from '$lib/format/number';

const created = (r: RunMeta) => {
	const t = Date.parse(r.createdAt);
	return Number.isNaN(t) ? -Infinity : t;
};

/**
 * The run the page shows and the one before it (by createdAt; ties keep the
 * list order, which is newest first). `wanted` is the URL's `run=`; without
 * it, or when it names no run in the list, the newest run, as the Summary
 * picks (overview/latestRun.ts pickRuns). null without runs.
 */
export function pickRiverRun(runs: readonly RunMeta[] | null, wanted: string | null): { run: RunMeta; previous: RunMeta | null } | null {
	if (!runs?.length) return null;
	const sorted = runs.map((r, i) => ({ r, i })).sort((a, b) => created(b.r) - created(a.r) || a.i - b.i).map((x) => x.r);
	const at = Math.max(0, wanted ? sorted.findIndex((r) => r.id === wanted) : 0);
	return { run: sorted[at]!, previous: sorted[at + 1] ?? null };
}

export type RiverKpiId = 'ewr' | 'below' | 'outflow';

export interface RiverKpi {
	id: RiverKpiId;
	term: string;
	/** HelpTip key for the term. */
	help?: string;
	value: string;
	unit: string;
	sub: string[];
	/** Worth a look (same thresholds as the Summary). The sub lines say why in words. */
	flagged: boolean;
	/** Change from the previous run; null when either run lacks the figure. */
	delta: MetricDelta | null;
	spec: MetricSpec;
}

const YEAR = 365.25;

function change(prev: number | null | undefined, cur: number | null | undefined): MetricDelta | null {
	const m = metricDelta(prev, cur);
	return m.delta === null ? null : m;
}

/** Days below the EWR in an average year of the run. */
export const perYear = (daysNotMet: number, days: number) => (days > 0 ? (daysNotMet * YEAR) / days : 0);

/**
 * The page's three tiles: EWR not met (share of days at the outflow gauge,
 * worded as the Summary's card, ewr/notMet.ts, with the rule-table months
 * when the project has one), the days below it
 * (and per average year, which is what the change compares, since runs can
 * differ in length), the mean simulated outflow (the Summary's figure,
 * overview/latestRun.ts). `days` is the run's length. A fourth, the worst
 * month, restated the largest figure of the EWR by month grid's "All years"
 * row and was removed (2026-09-29, issue #175).
 */
export function riverKpis(s: RunSummary, days: number, previous: { summary: RunSummary; days: number } | null): RiverKpi[] {
	const c = s.catchment;
	const pc = previous?.summary.catchment;
	const ewr = ewrNotMet(c, days);
	const ewrSub = [ewr.count];
	const reserve = headlines(s, days, null).find((h) => h.id === 'reserve');
	if (reserve) ewrSub.push(`Reserve rules: ${reserve.value} of months`);

	const year = perYear(c.ewrDaysNotMet, days);
	const prevYear = pc ? perYear(pc.ewrDaysNotMet, previous!.days) : null;

	const outflow = headlines(s, days, previous?.summary ?? null).find((h) => h.id === 'outflow')!;

	return [
		{
			id: 'ewr',
			term: ewr.term,
			help: ewr.help,
			value: ewr.value,
			unit: ewr.unit,
			sub: ewrSub,
			flagged: ewr.flagged,
			delta: pc ? change(pc.ewrFractionDaysNotMet, c.ewrFractionDaysNotMet) : null,
			spec: { format: 'fraction', better: 'lower' }
		},
		{
			id: 'below',
			term: 'Days below the reserve',
			value: fmtNum(c.ewrDaysNotMet),
			unit: 'days',
			sub: [`${fmtNum(year, year < 10 ? 1 : 0)} in an average year`],
			flagged: ewr.flagged,
			delta: change(prevYear, pc ? year : null),
			spec: { format: 'days', better: 'lower', digits: 1 }
		},
		{
			id: 'outflow',
			term: outflow.term,
			value: outflow.value,
			unit: outflow.unit,
			sub: outflow.sub,
			flagged: false,
			delta: outflow.delta,
			spec: outflow.spec
		}
	];
}

/** What each tile's change is against: the per-year figure for the days below. */
export const deltaLabel = (id: RiverKpiId) => (id === 'below' ? 'a year vs previous run' : 'vs previous run');

/**
 * The EWR the run was tested against, for the context line: the pragmatic
 * EWR at the outflow gauge always (it drives the shortfall and the days
 * below), and the Reserve's rule tables at their sites when the project has
 * any (summary.ewrAssurance).
 */
export function ewrRuleText(s: Pick<RunSummary, 'ewrAssurance'>): string {
	const sites = (s.ewrAssurance ?? []).map((x) => (x.isOutlet ? 'the outlet' : x.name));
	const base = 'EWR: pragmatic, by month';
	if (!sites.length) return base;
	const list = sites.length < 3 ? sites.join(' and ') : `${sites.slice(0, -1).join(', ')} and ${sites.at(-1)}`;
	return `${base} · Reserve rules at ${list}`;
}

/**
 * The page's "On this page" menu (common/SectionNav): every panel in page
 * order, by its `#res-…` id (links.ts RIVER_ANCHORS), grouped by the question
 * it answers. Reserve compliance only when the run has it, as the page shows
 * the panel only then.
 */
export function riverNavGroups(hasReserveCompliance: boolean): NavGroup[] {
	return [
		{
			label: 'The reserve',
			sections: [
				{ id: 'res-ewr', label: 'Flow vs reserve' },
				{ id: 'res-reserve-years', label: 'Days below, by year' },
				...(hasReserveCompliance ? [{ id: 'res-reserve', label: 'Reserve compliance' }] : []),
				{ id: 'res-ewr-grid', label: 'EWR by month' }
			]
		},
		{
			label: 'How sure, and what if',
			sections: [
				{ id: 'res-uncertainty', label: 'Uncertainty' },
				{ id: 'res-outcomes', label: 'Outcome matrix' },
				{ id: 'res-outlook', label: 'Seasonal outlook' }
			]
		},
		{ label: 'Water balance', sections: [{ id: 'res-water-account', label: 'Water account' }] }
	];
}
