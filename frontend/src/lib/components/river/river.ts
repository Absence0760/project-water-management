// EWR (River & reserve until issue #558; issue #17, option A · Outcomes): which
// run the page shows, the run it is compared with, its two KPI tiles and the
// context line. The
// panels themselves are the ones that were Runs &
// results' River & Reserve group, moved here unchanged (docs/ui.md § EWR);
// their `#res-…` ids moved with them, so an old
// `?tab=runs&run=…#res-reserve` link is sent here (links.ts riverAnchor).
import { metricDelta, type MetricDelta, type RunSummary } from '@water-management/engine';
import type { EwrHeadline, RunMeta } from '#lib/api/types.js';
import type { NavGroup } from '#lib/components/common/sectionNav.js';
import type { MetricSpec } from '#lib/components/compare/delta.js';
import { dailyMonthsHeading, daysBelowTest, ewrNotMet, type DailyEwrSource } from '#lib/components/ewr/notMet.js';
import { headlines } from '#lib/components/overview/latestRun.js';
import { flowHeading } from '#lib/components/overview/summaryChart.js';
import { fmtNum } from '#lib/format/number.js';
import { EWR_MAP_ANCHOR, EWR_MAP_HEADING, EWR_MONTHS_HEADING, RESERVE_MONTHS_HEADING } from './links';
import { IRRIGATION_SUPPORT_HEADING } from '#lib/components/outcomes/irrigationSupport.js';
import { runScenario } from '#lib/components/runs/scenarioRun.js';

const created = (r: RunMeta) => {
	const t = Date.parse(r.createdAt);
	return Number.isNaN(t) ? -Infinity : t;
};

/**
 * The run the page shows and the one before it (by createdAt; ties keep the
 * list order, which is newest first). `wanted` is the URL's `run=`; without
 * it, or when it names no run in the list, the newest run, as the Summary
 * picks (overview/latestRun.ts pickRuns). `gone`: `wanted` names a run
 * that isn't in the list (deleted since the link was made), so the page
 * says it shows the newest instead, as Hydrological units does. null
 * without runs.
 */
export function pickRiverRun(runs: readonly RunMeta[] | null, wanted: string | null): { run: RunMeta; previous: RunMeta | null; gone: boolean } | null {
	if (!runs?.length) return null;
	const sorted = runs.map((r, i) => ({ r, i })).sort((a, b) => created(b.r) - created(a.r) || a.i - b.i).map((x) => x.r);
	const found = wanted ? sorted.findIndex((r) => r.id === wanted) : 0;
	const at = Math.max(0, found);
	return { run: sorted[at]!, previous: sorted[at + 1] ?? null, gone: found < 0 };
}

/** The note under the page's header when the run shown is a scenario's (scenarioRunNote). */
export interface ScenarioRunNote {
	/** The scenario's name, as the run recorded it once the scenario is gone. */
	name: string;
	/** The scenario, to open it; null once it is deleted. */
	scenarioId: string | null;
	/** The base run the scenario run was made on, when it is still in the list (the note's "Show the base run"). */
	base: RunMeta | null;
}

/**
 * What the page says of a scenario's run (isScenarioRun, also once the
 * scenario is deleted): which scenario, and the base run it was made on
 * (`scenarioBaseRunId`, the base its snapshot recorded) when that run is still
 * in the list, so one link switches the page to it. null for a run of the
 * model.
 */
export function scenarioRunNote(run: RunMeta, runs: readonly RunMeta[] | null): ScenarioRunNote | null {
	const scenario = runScenario(run);
	if (!scenario) return null;
	const baseId = run.scenarioBaseRunId;
	return {
		name: scenario.name || run.label || 'Untitled scenario',
		scenarioId: scenario.id,
		base: (baseId && runs?.find((r) => r.id === baseId)) || null
	};
}

export type RiverKpiId = 'reserve' | 'ewr' | 'outflow';

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
 * The page's two tiles. The first is the EWR headline, the card that headed
 * the Summary until issue #558 merged it with this page's EWR not met tile
 * (both from ewr/notMet.ts): when the project judges by a Reserve rule table
 * (`choice`: settings.ewrHeadline, issue #444; overview/latestRun.ts
 * headlines) it is *Reserve rules met* (the share of months, at which site,
 * the longest run not met), with the pragmatic EWR's days under it, labelled
 * as such; otherwise *EWR not met* (share of days at the outflow gauge),
 * with the days not met of the record and how many in an average year. The
 * second is the mean simulated outflow (overview/latestRun.ts). `days` is
 * the run's length. A third tile, the days below the reserve, repeated the
 * EWR tile's count, and its per-year figure is the share × 365.25, so its
 * change said what this tile's does; it became the average-year sub line
 * (issue #177). A fourth, the worst month, restated the largest figure of
 * the EWR by month grid's "All years" row and was removed (2026-09-29, issue
 * #175).
 */
export function riverKpis(s: RunSummary, days: number, previous: { summary: RunSummary; days: number } | null, choice?: EwrHeadline | null): RiverKpi[] {
	const c = s.catchment;
	const pc = previous?.summary.catchment;
	const ewr = ewrNotMet(c, days);
	const year = perYear(c.ewrDaysNotMet, days);
	const perYearText = fmtNum(year, year < 10 ? 1 : 0, true);
	const yearLine = `${perYearText} ${perYearText === '1' ? 'day' : 'days'} in an average year`;
	const all = headlines(s, days, previous?.summary ?? null, choice);
	const reserve = all.find((h) => h.id === 'reserve');
	const outflow = all.find((h) => h.id === 'outflow')!;

	const head: RiverKpi = reserve
		? {
				id: 'reserve',
				term: reserve.term,
				help: reserve.help,
				value: reserve.value,
				unit: reserve.unit,
				// The rule table's months, then the pragmatic EWR the strip and the flow chart count, named as that test.
				sub: [...reserve.sub, `${ewr.term} (pragmatic): ${ewr.value} of days, ${ewr.count}`, yearLine],
				flagged: reserve.flagged,
				delta: reserve.delta,
				spec: reserve.spec
			}
		: {
				id: 'ewr',
				term: ewr.term,
				help: ewr.help,
				value: ewr.value,
				unit: ewr.unit,
				sub: [ewr.count, yearLine],
				flagged: ewr.flagged,
				delta: pc ? change(pc.ewrFractionDaysNotMet, c.ewrFractionDaysNotMet) : null,
				spec: { format: 'fraction', better: 'lower' }
			};

	return [
		head,
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

// The two monthly panels' headings (issue #465), in links.ts so Runs & results' side index names them too.
export { EWR_MONTHS_HEADING, RESERVE_MONTHS_HEADING };

/**
 * What `#res-reserve` says under the daily EWR's months when the run has no
 * Reserve rule table (issue #465: before, the panel was simply absent and
 * nothing said why). With none in the project, a table is needed to judge
 * the months by it too (set in Settings → Reserve rule tables, by an
 * editor); with one the run lacks (made before the table, or by an engine
 * before 0.21.0), a new run shows it.
 */
export function reserveStubText(projectHasTable: boolean, canEdit: boolean): { lead: string; link: string | null } {
	if (projectHasTable) return { lead: 'This run was made without the project’s Reserve rule table. Run the model again to judge the months by it too.', link: null };
	return { lead: 'To judge the months by a Reserve rule table too:', link: canEdit ? 'set one in Settings → Reserve rule tables' : 'an editor sets one in Settings → Reserve rule tables' };
}

/** What `#res-reserve` judges the months by: the daily EWR in use (engine ≥ 1.116.0), or the Reserve rule tables. */
export type MonthsJudge = 'daily' | 'rules';

/**
 * Which judgement `#res-reserve` shows. The daily EWR in use by default: a
 * client hydrologist expected the months met to follow Model settings → EWR
 * → Daily EWR from, where the panel read only the rule tables. With a rule
 * table in the run too: the reader's pick; else the tables when the project
 * judges its results by one by choice (settings.ewrHeadline `ruleTable`,
 * not Automatic) or the run lacks the daily months (made before engine
 * 1.116.0, or kept from this reader). Without a table, the daily EWR.
 */
export function monthsJudge(summary: Pick<RunSummary, 'ewrAssurance' | 'ewrDailyMonths'>, headline: EwrHeadline | null | undefined, picked: MonthsJudge | null): MonthsJudge {
	if (!summary.ewrAssurance?.length) return 'daily';
	if (picked) return picked;
	return headline?.source === 'ruleTable' || !summary.ewrDailyMonths ? 'rules' : 'daily';
}

/** The months-met panel's heading for what it shows: "Reserve rules met, by month", or the daily EWR's (notMet.ts dailyMonthsHeading). */
export const monthsMetHeading = (judge: MonthsJudge, daily?: DailyEwrSource): string => (judge === 'rules' ? RESERVE_MONTHS_HEADING : dailyMonthsHeading(daily));

/**
 * The page's "On this page" menu (common/SectionNav): every panel in page
 * order (not the reserve strip beside the tiles: it is on the first screen), by its `#res-…` id (links.ts RIVER_ANCHORS), grouped by the question
 * it answers: the findings first (the reserve, then the water account), then
 * the run-it-yourself tools (issue #465). Reserve rules met is always listed:
 * without a rule table its panel says what it needs. Each link says its
 * panel's heading word for word, on the bar too (issue #586 R4-F).
 * `ruleLine`: the run stored the outlet's rule requirement, so the flow chart
 * draws it and keeps its "Flow vs reserve" name (summaryChart.ts flowHeading).
 * `headlineRuleTable`: the headline judges by a rule table (the project's
 * settings.ewrHeadline, issue #444), which names the flow chart as it does
 * the chart's own heading. `monthsHeading`: the months-met panel's heading as
 * shown (monthsMetHeading; Reserve rules met when not given).
 */
export function riverNavGroups(ruleLine: boolean, headlineRuleTable: boolean, daily?: DailyEwrSource, monthsHeading?: string): NavGroup[] {
	return [
		{
			label: 'The reserve',
			sections: [
				{ id: 'res-ewr', label: flowHeading(headlineRuleTable, ruleLine, daily) },
				{ id: 'res-reserve-years', label: reserveYearsWords(headlineRuleTable, daily).heading },
				{ id: 'res-reserve', label: monthsHeading ?? RESERVE_MONTHS_HEADING },
				{ id: 'res-ewr-grid', label: EWR_MONTHS_HEADING },
				{ id: EWR_MAP_ANCHOR, label: EWR_MAP_HEADING }
			]
		},
		{ label: 'Water balance', sections: [{ id: 'res-water-account', label: 'Water account' }] },
		{
			label: 'How sure, and what if',
			sections: [
				{ id: 'res-uncertainty', label: 'Uncertainty bands' },
				{ id: 'res-sensitivity', label: 'Sensitivity runs' },
				{ id: 'res-outcomes', label: 'Outcome matrix' },
				{ id: 'res-irrigation', label: IRRIGATION_SUPPORT_HEADING },
				{ id: 'res-outlook', label: 'Seasonal outlook' }
			]
		}
	];
}
