// River & reserve (issue #17, option A · Outcomes): which run the page shows,
// the run it is compared with, its two KPI tiles and the context line. The
// panels themselves are the ones that were Runs &
// results' River & Reserve group, moved here unchanged (docs/ui.md § River &
// reserve); their `#res-…` ids moved with them, so an old
// `?tab=runs&run=…#res-reserve` link is sent here (links.ts riverAnchor).
import { metricDelta, type MetricDelta, type RunSummary } from '@water-management/engine';
import type { EwrHeadline, RunMeta } from '$lib/api/types';
import type { NavGroup } from '$lib/components/common/sectionNav';
import type { MetricSpec } from '$lib/components/compare/delta';
import { daysBelowTest, ewrNotMet, type DailyEwrSource } from '$lib/components/ewr/notMet';
import { headlines } from '$lib/components/overview/latestRun';
import { flowHeading } from '$lib/components/overview/summaryChart';
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

export type RiverKpiId = 'ewr' | 'outflow';

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
 * The page's two tiles: EWR not met (share of days at the outflow gauge,
 * worded as the Summary's card, ewr/notMet.ts; its sub lines are the days
 * not met of the record and how many in an average year, both the same
 * pragmatic EWR test, then the rule-table months, labelled as such, when the
 * project judges by a rule table, `choice`: settings.ewrHeadline, issue #444)
 * and the mean simulated outflow (the Summary's figure,
 * overview/latestRun.ts). `days` is the run's length. A third tile, the days
 * below the reserve, repeated this tile's count, and its per-year figure is
 * the share × 365.25, so its change said what this tile's does; it became the
 * average-year sub line (issue #177). A fourth, the worst month, restated the
 * largest figure of the EWR by month grid's "All years" row and was removed
 * (2026-09-29, issue #175).
 */
export function riverKpis(s: RunSummary, days: number, previous: { summary: RunSummary; days: number } | null, choice?: EwrHeadline | null): RiverKpi[] {
	const c = s.catchment;
	const pc = previous?.summary.catchment;
	const ewr = ewrNotMet(c, days);
	const year = perYear(c.ewrDaysNotMet, days);
	const perYearText = fmtNum(year, year < 10 ? 1 : 0, true);
	const ewrSub = [ewr.count, `${perYearText} ${perYearText === '1' ? 'day' : 'days'} in an average year`];
	const reserve = headlines(s, days, null, choice).find((h) => h.id === 'reserve');
	if (reserve) ewrSub.push(`Reserve rules: ${reserve.value} of months`);

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

/**
 * The EWR the run was tested against, for the context line: the pragmatic
 * EWR at the outflow gauge always (it drives the shortfall and the EWR not
 * met tile), and the Reserve's rule tables at their sites when the project has
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
 * The water-year panel's heading: it counts the days below the pragmatic EWR
 * (ReserveYearsChart), so beside a Reserve rule table it names that test, not
 * "the reserve" (ewr/notMet.ts daysBelowTest, issue #177). `below` is the
 * test's name for the chart's own labels.
 */
export function reserveYearsWords(ruleTable: boolean, daily?: DailyEwrSource): { heading: string; below: string } {
	const below = daysBelowTest(ruleTable, daily);
	return { heading: `Days below ${below}, each water year`, below };
}

/**
 * The two monthly panels' headings on this page, which tell them apart
 * (issue #465): Reserve compliance (`#res-reserve`) counts the months a
 * Reserve rule table's requirement was met; the EWR grid (`#res-ewr-grid`)
 * counts the days below the daily EWR. Both were "… compliance by month".
 * The printable report and Compare runs keep the panels' own names.
 */
export const RESERVE_MONTHS_HEADING = 'Reserve rules met, by month';
export const EWR_MONTHS_HEADING = 'Days below the EWR, by month';

/**
 * What `#res-reserve` says without a Reserve rule table in the run (issue
 * #465): before, the panel was simply absent and nothing said why. With
 * none in the project, it needs one (set in Settings → Reserve rule tables,
 * by an editor); with one the run lacks (made before the table, or by an engine before
 * 0.21.0), a new run shows it.
 */
export function reserveStubText(projectHasTable: boolean, canEdit: boolean): { lead: string; link: string | null } {
	if (projectHasTable) return { lead: 'This run was made without the project’s Reserve rule table. Run the model again to see it.', link: null };
	return { lead: 'Needs a Reserve rule table:', link: canEdit ? 'set one in Settings → Reserve rule tables' : 'an editor sets one in Settings → Reserve rule tables' };
}

/**
 * The page's "On this page" menu (common/SectionNav): every panel in page
 * order, by its `#res-…` id (links.ts RIVER_ANCHORS), grouped by the question
 * it answers: the findings first (the reserve, then the water account), then
 * the run-it-yourself tools (issue #465). Reserve rules met is always listed:
 * without a rule table its panel says what it needs.
 * `ruleLine`: the run stored the outlet's rule requirement, so the flow chart
 * draws it and keeps its "Flow vs reserve" name (summaryChart.ts flowHeading).
 * `headlineRuleTable`: the headline judges by a rule table (the project's
 * settings.ewrHeadline, issue #444), which names the flow chart as it does
 * the chart's own heading.
 */
export function riverNavGroups(ruleLine: boolean, headlineRuleTable: boolean, daily?: DailyEwrSource): NavGroup[] {
	return [
		{
			label: 'The reserve',
			sections: [
				{ id: 'res-ewr', label: flowHeading(headlineRuleTable, ruleLine, daily) },
				{ id: 'res-reserve-years', label: 'Days below, by year' },
				{ id: 'res-reserve', label: 'Reserve rules met' },
				{ id: 'res-ewr-grid', label: 'Days below, by month' }
			]
		},
		{ label: 'Water balance', sections: [{ id: 'res-water-account', label: 'Water account' }] },
		{
			label: 'How sure, and what if',
			sections: [
				{ id: 'res-uncertainty', label: 'Uncertainty' },
				{ id: 'res-outcomes', label: 'Outcome matrix' },
				{ id: 'res-outlook', label: 'Seasonal outlook' }
			]
		}
	];
}
