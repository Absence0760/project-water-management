// Overview → Latest run: which run the strip shows, the run it is compared
// with, and its four headline cards. The figures and their labels are the
// ones the Runs tab's headline (runs/RunSummaryView.svelte) shows, so the two
// never disagree; the change against the previous run is formatted the way
// the compare page does it (compare/delta.ts).
import { fromEpochDay, metricDelta, toEpochDay, type MetricDelta, type RunSummary } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';
import type { MetricSpec } from '$lib/components/compare/delta';
import { headlineSite } from '$lib/components/runs/ewrAssurance';
import { m3DayToM3s, SUPPLY_TARGET } from '$lib/components/runs/results';
import { agoText, daysBetween, windowText, type DataEnd } from '$lib/format/age';
import { fmtDay, fmtNum, fmtPct, fmtQty, localIsoDate } from '$lib/format/number';
import { calibrationSample } from '$lib/components/calibration/sample';
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

export type HeadlineId = 'reserve' | 'ewr' | 'supply' | 'nse' | 'outflow' | 'dams';

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
 * outflow in the line under them.
 */
export function headlines(s: RunSummary, days: number, previous: RunSummary | null): Headline[] {
	const out: Headline[] = [];
	const c = s.catchment;
	const pc = previous?.catchment;

	const reserve = headlineSite(s);
	if (reserve) {
		const o = reserve.overall;
		const prevSite = previous ? headlineSite(previous) : null;
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
		out.push({
			id: 'ewr',
			term: 'EWR not met',
			help: 'catchment.ewrFractionDaysNotMet',
			value: fmtPct(c.ewrFractionDaysNotMet),
			unit: 'of days',
			sub: [`${fmtNum(c.ewrDaysNotMet)} of ${fmtNum(days)} days at the outflow gauge`],
			flagged: c.ewrFractionDaysNotMet > 0.05,
			// The pragmatic test runs on every run, so a previous run always has it
			// (unless its headline was a rule table: then the two cards differ).
			delta: previous && !headlineSite(previous) ? change(pc?.ewrFractionDaysNotMet, c.ewrFractionDaysNotMet) : null,
			spec: { format: 'fraction', better: 'lower' }
		});
	}

	const farms = s.farms ?? [];
	const short = farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET).length;
	const supplied = supplyFraction(s);
	const target = fmtPct(SUPPLY_TARGET, 0);
	out.push({
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
	});

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

/** Where the dam figures are: still loading, failed, the run has no dams, or all dams together (damLevels.ts damsToday). */
export type DamsState = { state: 'loading' } | { state: 'error' } | { state: 'none' } | { state: 'ready'; today: DamsToday };

/** The Dams page (each dam's level and storage chart), where the Dams today card leads. */
export const DAMS_HREF = '?tab=dams';

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
