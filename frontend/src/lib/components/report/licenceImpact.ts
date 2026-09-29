// The impact report's licence-impact board (issue #53 R7, docs/ui.md
// § Report, docs/design/planning-outputs.md §3.7): one column per water-year
// class, with the annual waterfall (natural flow → existing use → the
// proposed extra use → other → flow left) and the months below the Reserve,
// baseline vs this run. The numbers are the engine's
// (views/licenceImpact.ts licenceImpactByYearClass, describeLicenceImpact);
// this module adapts the three daily series it reads (./impactSeries.ts,
// fetched by the report route) and words the result.
// It reports what the runs did; it never recommends.
//
// The background is the run the report is "against" (its baseline). Its use
// is labelled as that run's use, or as *existing authorised* use when it is
// a full-allocation run (settings.allocationMode, engine ≥ 1.18.0,
// allocations.md): compare an application with such a baseline and only the
// wording changes. A pair where only one run is at full allocation is said so.
import {
	describeLicenceImpact,
	licenceImpactByYearClass,
	type DailySeries,
	type LicenceImpact,
	type LicenceImpactClass,
	type LicenceImpactVerdict,
	type OutcomeMetric,
	type RunSeries,
	type YearClassMethod
} from '@water-management/engine';
import type { RunCompareResponse } from '$lib/api/types';
import { boundsText, OUTLET_SITE, type MatrixSite } from '$lib/components/outcomes/matrix';
import { fmtNum } from '$lib/format/number';
import type { ImpactSeries } from './impactSeries';

/** Stored values (JSON has no NaN) back to the engine's NaN, as a catchment series. */
const toRunSeries = (key: string, s: DailySeries | null): RunSeries[] =>
	s ? [{ nodeId: null, key, label: key, unit: 'm³/day', values: s.values.map((v) => (v === null ? Number.NaN : v)) }] : [];

export const VERDICT_LABEL: Readonly<Record<OutcomeMetric, Record<LicenceImpactVerdict, string>>> = Object.freeze({
	reserveMonthsMet: { moreBelow: 'More months below the Reserve', fewerBelow: 'Fewer months below the Reserve', noChange: 'No change in months below the Reserve', notEnoughYears: 'Not enough years' },
	daysBelowEwr: { moreBelow: 'More days below the EWR', fewerBelow: 'Fewer days below the EWR', noChange: 'No change in days below the EWR', notEnoughYears: 'Not enough years' }
});

export interface WaterfallStep {
	id: 'natural' | 'existing' | 'proposed' | 'other' | 'left';
	label: string;
	/** m³ a year, signed as it moves the flow: + for natural and left, − for what is taken. */
	m3: number;
	text: string;
}

export interface BoardColumn {
	id: string;
	label: string;
	bounds: string;
	nYears: number;
	enoughYears: boolean;
	/** Null when there are too few years. */
	waterfall: WaterfallStep[] | null;
	/** Months (or days) below, baseline and this run, and the change ("+4", "−2", "0"); null when too few years. */
	below: { background: number; application: number; change: string; units: number } | null;
	verdict: LicenceImpactVerdict;
	verdictLabel: string;
	/** describeLicenceImpact's sentence. */
	text: string;
}

export type BoardView =
	| {
			status: 'ok';
			metric: OutcomeMetric;
			/** "Months below the Reserve (the rule table at the outlet)". */
			belowLabel: string;
			/** The baseline run's name, in quotes. */
			background: string;
			/** Complete water years classed. */
			nYears: number;
			method: LicenceImpact['method'];
			columns: BoardColumn[];
			/** Existing use is the background run's own, and what existing *authorised* use needs. */
			existingNote: string;
			notes: string[];
	  }
	| { status: 'unavailable'; reason: string };

const m3 = (v: number) => `${fmtNum(v)} m³`;
const signed = (n: number) => (n > 0 ? `+${fmtNum(n)}` : n < 0 ? `−${fmtNum(-n)}` : '0');

function waterfallOf(c: LicenceImpactClass, background: string, authorised: boolean): WaterfallStep[] | null {
	const w = c.waterfall;
	if (!w) return null;
	const step = (id: WaterfallStep['id'], label: string, v: number): WaterfallStep => ({ id, label, m3: v, text: id === 'natural' || id === 'left' || Math.round(v) === 0 ? m3(Math.abs(v) < 0.5 ? 0 : v) : v < 0 ? `+${m3(-v)}` : `−${m3(v)}` });
	return [
		step('natural', 'Natural flow', w.naturalM3),
		step('existing', `${authorised ? 'Existing authorised use' : 'Existing use'} in ${background}`, w.existingUseM3),
		step('proposed', 'Proposed use (this run − baseline)', w.proposedM3),
		step('other', 'Other: dams, storage, groundwater, land cover', w.otherM3),
		step('left', 'Flow left at the outlet', w.leftM3)
	];
}

export interface BoardInput {
	data: Pick<RunCompareResponse, 'a' | 'b'>;
	series: ImpactSeries;
	method: YearClassMethod;
	/** The Reserve site (outcomes/matrix.ts chooseSite); the outlet by default. */
	site?: MatrixSite;
}

/** The board for an impact report: its baseline as the background, this run as the application. */
export function buildLicenceImpactBoard(input: BoardInput): BoardView {
	const { a, b } = input.data;
	const background = `“${a.run.label || 'Untitled run'}”`;
	if (!input.series.background.natural) return { status: 'unavailable', reason: 'The baseline has no natural flow series, so its water years cannot be classed.' };
	const notes: string[] = [];
	// A gauge needs its rule table in both runs; otherwise the outlet, said so (never the outlet's numbers in the gauge's name).
	let site = input.site ?? OUTLET_SITE;
	if (site.id !== null && ![a, b].every((s) => s.run.summary.ewrAssurance?.some((x) => x.nodeId === site.id))) {
		notes.push(`The baseline or this run has no Reserve results at ${site.where}, so the board reads the outlet.`);
		site = OUTLET_SITE;
	}
	let impact: LicenceImpact;
	try {
		impact = licenceImpactByYearClass({
			background: { startDate: a.run.startDate, summary: a.run.summary, series: [...toRunSeries('natural_flow', input.series.background.natural), ...toRunSeries('ewr_shortfall', input.series.background.ewrShortfall)] },
			application: { startDate: b.run.startDate, summary: b.run.summary, series: toRunSeries('ewr_shortfall', input.series.application.ewrShortfall) },
			siteNodeId: site.id,
			yearClassMethod: input.method
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			status: 'unavailable',
			reason: /water account/.test(msg)
				? 'One of the runs was made before the engine kept a water account (engine 0.32.0). Run the model again to see this board.'
				: /ewr_shortfall/.test(msg)
					? 'One of the runs has no EWR shortfall series, so its days below the EWR cannot be counted.'
					: `The board could not be built: ${msg}`
		};
	}
	// A full-allocation baseline (engine ≥ 1.18.0, settings.allocationMode, allocations.md) runs every holder at their registered volume: its use is existing *authorised* use.
	const mode = (r: typeof a) => r.run.summary.allocations?.mode ?? 'none';
	const authorised = mode(a) === 'fullAllocation';
	if (authorised && mode(b) !== 'fullAllocation')
		notes.push('The baseline runs every holder at their full registered volume, but this run doesn’t, so the proposed step also counts the other holders going back to their modelled use. Run the application with the allocation mode at full allocation too.');
	else if (!authorised && mode(b) === 'fullAllocation')
		notes.push('This run holds every holder at their full registered volume, but the baseline doesn’t, so the proposed step also counts the other holders going up to their registered volumes. Compare it with a full-allocation baseline.');
	const unit = impact.metric === 'reserveMonthsMet' ? 'months' : 'days';
	const names = { background: `the baseline ${background}`, application: 'this run' };
	const columns: BoardColumn[] = impact.classes.map((c) => ({
		id: c.classId,
		label: c.label,
		bounds: boundsText(c),
		nYears: c.nYears,
		enoughYears: c.enoughYears,
		waterfall: waterfallOf(c, `the baseline ${background}`, authorised),
		below: c.below ? { background: c.below.background, application: c.below.application, change: signed(c.below.change), units: c.below.units } : null,
		verdict: c.verdict,
		verdictLabel: VERDICT_LABEL[impact.metric][c.verdict],
		text: describeLicenceImpact(impact.metric, c, names)
	}));
	notes.push(...impact.warnings);
	if (unit === 'days' && !impact.warnings.length) notes.push('Neither run has a Reserve rule table at the outlet, so the board counts days below the pragmatic EWR.');
	const classed = impact.classes.reduce((s, c) => s + c.nYears, 0);
	return {
		status: 'ok',
		metric: impact.metric,
		belowLabel: impact.metric === 'reserveMonthsMet' ? `Months below the Reserve (the rule table at ${site.where})` : 'Days below the pragmatic EWR at the outlet',
		background,
		nYears: classed,
		method: impact.method,
		columns,
		existingNote: authorised
			? `Existing authorised use is the use in the baseline ${background}, a full-allocation run: every holder at their full registered volume, irrigation and other water users, less what returns to the river.`
			: `Existing use is the use in the baseline ${background} as that run modelled it: irrigation and other water users, less what returns to the river. For existing authorised use, compare with a baseline run at every holder’s full registered volume (Settings › Registered volumes › Allocation mode: full allocation, or a scenario that sets it).`,
		notes
	};
}
