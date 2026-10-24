// Overview → Latest run: which run the strip shows, the run it is compared
// with, and its four headline cards. The figures and their labels are the
// ones the Runs tab's headline (runs/RunSummaryView.svelte) shows, so the two
// never disagree; the change against the previous run is formatted the way
// the compare page does it (compare/delta.ts).
import { fromEpochDay, metricDelta, toEpochDay, type MetricDelta, type RunSummary } from '@water-management/engine';
import type { EwrHeadline, RunMeta } from '$lib/api/types';
import type { MetricSpec } from '$lib/components/compare/delta';
import { headlineSite } from '$lib/components/runs/ewrAssurance';
import { m3DayToM3s, SUPPLY_TARGET } from '$lib/components/runs/results';
import { agoText, daysBetween, windowText, type DataEnd } from '$lib/format/age';
import { fmtDay, fmtNum, fmtPct, fmtQty, localIsoDate } from '$lib/format/number';
import { calibrationSample } from '$lib/components/calibration/sample';
import { ewrNotMet } from '$lib/components/ewr/notMet';
import { AGO_DAYS, LOW_PCT, type DamsToday } from './damLevels';

export interface RunPick {
	/** The run the strip shows. */
	latest: RunMeta;
	/** The run before it (by createdAt), for the "vs previous run" changes. */
	previous: RunMeta | null;
	/** The nominated evidence run, only when it is not `latest` (the strip links to it). */
	evidence: RunMeta | null;
}

const created = (r: RunMeta) => {
	const t = Date.parse(r.createdAt);
	return Number.isNaN(t) ? -Infinity : t;
};

/**
 * The strip shows the newest run by createdAt, even when an older run is the
 * nominated evidence. The Overview answers "what does the model say now?",
 * and the newest run is the only one that reflects the latest data and
 * edits; showing an older evidence run as "latest" would hide them. The
 * evidence run, when it is a different run, is named and linked beside the
 * strip so it can't be mistaken for the one shown. Ties keep the list order
 * (the API lists newest first). null when there are no runs.
 */
export function pickRuns(runs: readonly RunMeta[] | null): RunPick | null {
	if (!runs?.length) return null;
	const sorted = runs.map((r, i) => ({ r, i })).sort((a, b) => created(b.r) - created(a.r) || a.i - b.i);
	const latest = sorted[0]!.r;
	const evidence = runs.find((r) => r.evidence === 'current') ?? null;
	return {
		latest,
		previous: sorted[1]?.r ?? null,
		evidence: evidence && evidence.id !== latest.id ? evidence : null
	};
}

/** "today", "yesterday", "12 days ago": how long ago a run was made, by the viewer's calendar. */
export function ranAgo(createdAt: string, now: Date = new Date()): string {
	const t = new Date(createdAt);
	if (Number.isNaN(t.getTime())) return '';
	// A clock a little ahead of the server's still reads "today", not "in the future".
	return agoText(Math.max(0, daysBetween(localIsoDate(t), localIsoDate(now))));
}

/** Days a run covers, both ends included (a forecast run's forecast days too: the span its header shows). */
export const runDays = (r: Pick<RunMeta, 'startDate' | 'endDate'>) => toEpochDay(r.endDate) - toEpochDay(r.startDate) + 1;

/**
 * Days of the record a run's summary covers: runDays, but on a forecast run
 * only the days before its forecast (WP-2.12), since every summary figure
 * is the history's. The denominator of any "X of N days" beside them (issue
 * #51: "EWR not met on X of N days" counted X over the history and N to the
 * forecast's end).
 */
export const historyDays = (r: Pick<RunMeta, 'startDate' | 'endDate' | 'forecastFrom'>) =>
	r.forecastFrom ? Math.max(0, Math.min(toEpochDay(r.forecastFrom), toEpochDay(r.endDate) + 1) - toEpochDay(r.startDate)) : runDays(r);

/** The last day of the record a run's summary covers: its end date, or on a forecast run the day before the forecast. */
export const historyEnd = (r: Pick<RunMeta, 'startDate' | 'endDate' | 'forecastFrom'>) => fromEpochDay(toEpochDay(r.startDate) + historyDays(r) - 1);

export type HeadlineId = 'reserve' | 'ewr' | 'supply' | 'shortfall' | 'curtailed' | 'nse' | 'outflow' | 'dams';

export interface Headline {
	id: HeadlineId;
	term: string;
	/** HelpTip key for the term. */
	help?: string;
	value: string;
	unit: string;
	/** Smaller lines under the value. */
	sub: string[];
	/** Worth a look (same thresholds as the Runs tab). The sub lines say why in words. */
	flagged: boolean;
	/** Change from the previous run; null when either run lacks the figure or they aren't comparable. */
	delta: MetricDelta | null;
	spec: MetricSpec;
	/** What the change is against, after it; "vs previous run" when absent. */
	deltaLabel?: string;
	/** The page behind the card: its term links there, over the whole card (Dams today → the Dams page). */
	href?: string;
}

/** Share of all farms' demand supplied (as the Runs tab's "Irrigation supplied"); null without demand. */
export function supplyFraction(s: Pick<RunSummary, 'farms'>): number | null {
	const farms = s.farms ?? [];
	const demand = farms.reduce((a, f) => a + f.avgDemandM3Day, 0);
	return demand > 0 ? farms.reduce((a, f) => a + f.avgSuppliedM3Day, 0) / demand : null;
}

const hasCalibration = (s: Pick<RunSummary, 'calibration'>) => !!s.calibration && s.calibration.days > 0;

/** A change only when both sides have the figure. */
function change(prev: number | null | undefined, cur: number | null | undefined): MetricDelta | null {
	const m = metricDelta(prev, cur);
	return m.delta === null ? null : m;
}

/**
 * The four headline cards: the Reserve (the monthly rule-table compliance
 * when the project has a rule table, else days below the pragmatic EWR),
 * irrigation supplied, the calibration NSE and the mean simulated outflow.
 * (Dam storage isn't in a run's summary, only in its daily series, so its
 * card is `damsHeadline`, built once they are fetched.) `previous` is the run
 * before, for the changes. The Summary shows the first three as cards and the
 * outflow in the line under them. `choice` is the project's settings.ewrHeadline
 * (issue #444; absent = `auto`): which test the Reserve card reports, for this
 * run and the one before alike.
 */
export function headlines(s: RunSummary, days: number, previous: RunSummary | null, choice?: EwrHeadline | null): Headline[] {
	const out: Headline[] = [];
	const c = s.catchment;
	const pc = previous?.catchment;

	const reserve = headlineSite(s, choice);
	if (reserve) {
		const o = reserve.overall;
		const prevSite = previous ? headlineSite(previous, choice) : null;
		// Only the same site is comparable (a rule table added elsewhere moves the headline).
		const same = prevSite && prevSite.nodeId === reserve.nodeId ? prevSite : null;
		const sub = [`${fmtNum(o.met)} of ${fmtNum(o.months)} months at ${reserve.isOutlet ? 'the outlet' : reserve.name}`];
		if (o.longestNotMetRun > 1) sub.push(`up to ${fmtNum(o.longestNotMetRun)} in a row not met`);
		out.push({
			id: 'reserve',
			term: 'Reserve rules met',
			help: 'reserve-compliance',
			value: o.rate === null ? '–' : fmtPct(o.rate),
			unit: 'of months',
			sub,
			flagged: o.rate !== null && o.rate < 1,
			delta: same ? change(same.overall.rate, o.rate) : null,
			spec: { format: 'fraction', better: 'higher' }
		});
	} else {
		const ewr = ewrNotMet(c, days);
		out.push({
			id: 'ewr',
			term: ewr.term,
			help: ewr.help,
			value: ewr.value,
			unit: ewr.unit,
			sub: [ewr.count],
			flagged: ewr.flagged,
			// The pragmatic test runs on every run, so a previous run always has it
			// (unless its headline was a rule table: then the two cards differ).
			delta: previous && !headlineSite(previous, choice) ? change(pc?.ewrFractionDaysNotMet, c.ewrFractionDaysNotMet) : null,
			spec: { format: 'fraction', better: 'lower' }
		});
	}

	out.push(supplyHeadline(s, previous));

	const cal = s.calibration;
	if (cal && hasCalibration(s)) {
		out.push({
			id: 'nse',
			term: 'Calibration NSE',
			help: 'stats.nse',
			value: fmtNum(cal.nse, 2),
			unit: '',
			sub: [`${fmtNum(cal.days)} days observed`, calibrationSample(cal).short],
			flagged: false,
			delta: previous && hasCalibration(previous) ? change(previous.calibration?.nse, cal.nse) : null,
			spec: { format: 'ratio', better: 'higher', digits: 2 }
		});
	} else {
		out.push({
			id: 'nse',
			term: 'Calibration',
			value: '–',
			unit: '',
			sub: ['no observed flow in the run'],
			flagged: false,
			delta: null,
			spec: { format: 'ratio', better: 'higher', digits: 2 }
		});
	}

	out.push({
		id: 'outflow',
		term: 'Mean simulated outflow',
		value: fmtQty(m3DayToM3s(c.meanSimulatedOutflowM3Day), 3),
		unit: 'm³/s',
		sub: c.meanNaturalFlowM3Day > 0 ? [`${fmtPct(c.meanSimulatedOutflowM3Day / c.meanNaturalFlowM3Day, 0)} of natural`] : [],
		flagged: false,
		delta: pc ? change(m3DayToM3s(pc.meanSimulatedOutflowM3Day), m3DayToM3s(c.meanSimulatedOutflowM3Day)) : null,
		spec: { format: 'ratio', better: 'neutral', digits: 3 }
	});
	return out;
}

/** Irrigation supplied: all units' supply over their demand (supplyFraction), and how many fell below SUPPLY_TARGET. */
export function supplyHeadline(s: RunSummary, previous: RunSummary | null): Headline {
	const farms = s.farms ?? [];
	const short = farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET).length;
	const supplied = supplyFraction(s);
	const target = fmtPct(SUPPLY_TARGET, 0);
	return {
		id: 'supply',
		term: 'Irrigation supplied',
		help: 'summary.fractionSupplied',
		value: supplied === null ? '–' : fmtPct(supplied),
		unit: 'of demand',
		sub: [
			!farms.length
				? 'no hydrological units in the run'
				: short
					? `${fmtNum(short)} of ${fmtNum(farms.length)} hydrological units below ${target}`
					: `all hydrological units ≥ ${target}`
		],
		flagged: short > 0,
		delta: previous ? change(supplyFraction(previous), supplied) : null,
		spec: { format: 'fraction', better: 'higher' }
	};
}

const YEAR_DAYS = 365.25;
const MM3 = 1e-6;

/** All units' mean daily deficit (demand not supplied), m³/day; null without units. */
export function deficitM3Day(s: Pick<RunSummary, 'farms'>): number | null {
	const farms = s.farms ?? [];
	return farms.length ? farms.reduce((a, f) => a + f.avgDeficitM3Day, 0) : null;
}

/** "1.23", "0.045": a volume in Mm³ to three significant figures where it is small. */
const mm3 = (v: number) => fmtQty(v, 2, false, 2);

/**
 * The Summary's Shortfall card (issue #558): the volume of demand the units
 * didn't get over the run (Σ each unit's mean deficit × the run's `days`, in
 * Mm³), and in an average year (× 365.25). The change from the previous run
 * is the average-year figure, since two runs rarely cover the same days.
 */
export function shortfallHeadline(s: RunSummary, days: number, previous: RunSummary | null): Headline {
	const deficit = deficitM3Day(s);
	const base = { id: 'shortfall' as const, term: 'Shortfall', help: 'summary.avgDeficitM3Day', spec: { format: 'ratio', better: 'lower', digits: 3 } as MetricSpec };
	if (deficit === null) return { ...base, value: '–', unit: '', sub: ['no hydrological units in the run'], flagged: false, delta: null };
	const demand = (s.farms ?? []).reduce((a, f) => a + f.avgDemandM3Day, 0);
	const year = deficit * YEAR_DAYS * MM3;
	const prev = previous ? deficitM3Day(previous) : null;
	return {
		...base,
		value: mm3(deficit * days * MM3),
		unit: 'Mm³',
		sub: [
			`demand not supplied over the run’s ${fmtNum(days)} days`,
			deficit > 0 ? `${mm3(year)} Mm³ in an average year${demand > 0 ? `, ${fmtPct(deficit / demand)} of demand` : ''}` : 'every unit got its whole demand'
		],
		flagged: false,
		delta: prev === null ? null : change(prev * YEAR_DAYS * MM3, year),
		deltaLabel: 'Mm³ a year, vs previous run'
	};
}

/** Days a drought restriction level was in force over the run (droughtRestriction.daysByLevel past index 0); null when the rule is off. */
export function restrictedDays(s: Pick<RunSummary, 'droughtRestriction'>): number | null {
	const by = s.droughtRestriction?.daysByLevel;
	return by ? by.slice(1).reduce((a, n) => a + n, 0) : null;
}

/** "level 2 at worst": the deepest restriction level the run reached. */
function deepest(s: Pick<RunSummary, 'droughtRestriction'>): string {
	const by = s.droughtRestriction?.daysByLevel ?? [];
	let top = 0;
	by.forEach((n, i) => {
		if (n > 0) top = i;
	});
	return `level ${fmtNum(top)} at worst`;
}

/**
 * The Summary's curtailment card (issue #558): the days the drought
 * restriction rule cut the units' demand, when the run has any; else the
 * worst-supplied unit and its share of demand supplied, with a line saying
 * the rule never restricted when it is on.
 */
export function curtailedHeadline(s: RunSummary, days: number, previous: RunSummary | null): Headline {
	const restricted = restrictedDays(s);
	const spec: MetricSpec = { format: 'fraction', better: 'higher' };
	if (restricted) {
		const prevDays = previous ? restrictedDays(previous) : null;
		return {
			id: 'curtailed',
			term: 'Units curtailed',
			help: 'drought-restriction',
			value: fmtNum(restricted),
			unit: restricted === 1 ? 'day' : 'days',
			sub: [`under a drought restriction, of ${fmtNum(days)} days`, `${fmtPct(restricted / days)} of the run, ${deepest(s)}`],
			flagged: true,
			delta: prevDays === null ? null : change(prevDays, restricted),
			deltaLabel: 'days, vs previous run',
			spec: { format: 'ratio', better: 'lower', digits: 0 }
		};
	}
	const farms = s.farms ?? [];
	const base = { id: 'curtailed' as const, term: 'Worst-supplied unit', help: 'summary.fractionSupplied', unit: '', flagged: false, delta: null, spec };
	const note = restricted === 0 ? ['no drought restriction days in the run'] : [];
	if (!farms.length) return { ...base, value: '–', sub: ['no hydrological units in the run', ...note] };
	// The lowest; on a tie, the first in the run's order (as the run sentence picks it).
	const worst = farms.reduce((a, b) => (b.fractionSupplied < a.fractionSupplied ? b : a));
	return {
		...base,
		value: fmtPct(worst.fractionSupplied),
		unit: 'supplied',
		sub: [worst.name || 'Unnamed hydrological unit', ...note],
		flagged: worst.fractionSupplied < SUPPLY_TARGET
	};
}

/**
 * The Summary's KPI row (issue #558): irrigation first. Irrigation supplied,
 * the Shortfall and the curtailment card; the Dams card (damsHeadline) joins
 * them once the dams are in. The EWR's headline card and the calibration NSE
 * are on the EWR page and Runs & results.
 */
export function summaryHeadlines(s: RunSummary, days: number, previous: RunSummary | null): Headline[] {
	return [supplyHeadline(s, previous), shortfallHeadline(s, days, previous), curtailedHeadline(s, days, previous)];
}

/** Where the dam figures are: still loading, failed, the run has no dams, or all dams together (damLevels.ts damsToday). */
export type DamsState = { state: 'loading' } | { state: 'error' } | { state: 'none' } | { state: 'ready'; today: DamsToday };

/** The Dams page (each dam's level and storage chart), where the Dams today card leads. */
export const DAMS_HREF = '?tab=dams';

/**
 * The last day the Dams card's figure is for: the dams' own last day once
 * their levels are in, else the run's history end (a forecast run's
 * `endDate` is in the future, so it can't say whether the figure is stale).
 */
export const damsEnd = (d: DamsState, run: Pick<RunMeta, 'startDate' | 'endDate' | 'forecastFrom'>): string =>
	d.state === 'ready' ? d.today.endDate : historyEnd(run);

/**
 * The "Dams today" card: all dams' storage at the end of the run as a share
 * of their capacity (capacity-weighted), and its change over the run's last
 * AGO_DAYS days (not against the previous run: the question is which way the
 * dams are heading). Flagged below LOW_PCT. `runEnd` is the run's last day and
 * its age: once that is stale the card is "Dams on 31 Dec 2024", since "today"
 * would claim figures the run doesn't have.
 */
export function damsHeadline(d: DamsState, runEnd: DataEnd | null = null): Headline {
	const base = {
		id: 'dams' as const,
		term: windowText(runEnd, 'Dams today', 'Dams on {date}'),
		href: DAMS_HREF,
		unit: '',
		flagged: false,
		delta: null,
		spec: { format: 'fraction', better: 'higher' } as MetricSpec
	};
	if (d.state === 'loading') return { ...base, value: '…', sub: ['loading dam levels'] };
	if (d.state === 'error') return { ...base, value: '–', sub: ['dam levels couldn’t be loaded'] };
	if (d.state === 'none') return { ...base, value: '–', sub: ['no dams in the run'] };
	const t = d.today;
	const low = t.pct < LOW_PCT;
	return {
		...base,
		value: fmtPct(t.pct / 100, 0),
		unit: 'full',
		sub: [`${fmtNum(t.dams)} dam${t.dams === 1 ? '' : 's'} on ${fmtDay(t.endDate)}${low ? `, below ${fmtNum(LOW_PCT)}%` : ''}`],
		flagged: low,
		delta: t.change === null ? null : change((t.pct - t.change) / 100, t.pct / 100),
		spec: { format: 'fraction', better: 'higher', digits: 0 },
		deltaLabel: `in ${fmtNum(AGO_DAYS)} days`
	};
}
