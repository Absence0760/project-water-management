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
	beforeForecast,
	describeLicenceImpact,
	licenceImpactByYearClass,
	type DailySeries,
	type EvidenceLicenceImpact,
	type EvidenceLicenceImpactUnavailable,
	type LicenceImpact,
	type LicenceImpactClass,
	type LicenceImpactVerdict,
	type OutcomeMetric,
	type RunSeries,
	type YearClassMethod
} from '@water-management/engine';
import type { RunCompareResponse } from '#lib/api/types.js';
import { boundsText, OUTLET_SITE, type MatrixSite } from '#lib/components/outcomes/matrix.js';
import { fmtNum } from '#lib/format/number.js';
import { dailyEwrNameOf } from '#lib/components/ewr/notMet.js';
import type { ImpactSeries } from './impactSeries';

/**
 * Stored values (JSON has no NaN) back to the engine's NaN, as a catchment
 * series. On a forecast run, the days before its first forecast day only
 * (issue #51): the board counts the record's years, as the run's summary does.
 */
const toRunSeries = (key: string, s: DailySeries | null, forecastFrom: string | null | undefined): RunSeries[] =>
	s
		? [{ nodeId: null, key, label: key, unit: 'm³/day', values: Array.from(beforeForecast(s.values, s.startDate, forecastFrom), (v) => (v === null ? Number.NaN : v)) }]
		: [];

export const VERDICT_LABEL: Readonly<Record<OutcomeMetric, Record<LicenceImpactVerdict, string>>> = Object.freeze({
	reserveMonthsMet: { moreBelow: 'More months below the Reserve', fewerBelow: 'Fewer months below the Reserve', noChange: 'No change in months below the Reserve', notEnoughYears: 'Not enough years' },
	daysBelowEwr: { moreBelow: 'More days below the EWR', fewerBelow: 'Fewer days below the EWR', noChange: 'No change in days below the EWR', notEnoughYears: 'Not enough years' }
});

/**
 * A mark beside each verdict, so its direction reads at a glance (the words
 * beside it carry the meaning; no colour: the board reports, it doesn't judge).
 */
export const VERDICT_MARK: Readonly<Record<LicenceImpactVerdict, string>> = Object.freeze({ moreBelow: '▲', fewerBelow: '▼', noChange: '=', notEnoughYears: '–' });

/** Each class's place in the record, for its column head: "the driest third of years". */
const CLASS_SHARE: Readonly<Record<'terciles' | 'quintiles', Record<string, string>>> = Object.freeze({
	terciles: { dry: 'the driest third of years', normal: 'the middle third', wet: 'the wettest third' },
	quintiles: { veryDry: 'the driest fifth of years', dry: 'the second-driest fifth', normal: 'the middle fifth', wet: 'the second-wettest fifth', veryWet: 'the wettest fifth' }
});

export interface WaterfallBar {
	id: WaterfallStep['id'];
	/** The step's full label (the list's), for the bar's tooltip. */
	label: string;
	/** Under the bar: "Natural", "Existing", "Proposed", "Other", "Left". */
	short: string;
	/** The bar spans from → to, m³ a year; `end` is the running total after it. */
	from: number;
	to: number;
	end: number;
	/** Over the bar, in the chart's unit: "1 800", "−100", "+40". */
	value: string;
}

const SHORT: Readonly<Record<WaterfallStep['id'], string>> = Object.freeze({ natural: 'Natural', existing: 'Existing', proposed: 'Proposed', other: 'Other', left: 'Left' });

/**
 * The waterfall as floating bars (LicenceWaterfall.svelte): natural and left
 * from zero, each step from the running total (a use takes, so its bar falls;
 * a negative use adds, so it rises), in m³ a year, thousand m³ a year from
 * 10 000, or million m³ a year once the natural flow passes a million, so a
 * bar's value stays short enough to sit over it.
 */
export function waterfallBars(steps: readonly WaterfallStep[]): { bars: WaterfallBar[]; max: number; unit: string } {
	const natural = Math.abs(steps.find((s) => s.id === 'natural')?.m3 ?? 0);
	const scale = natural >= 1e6 ? 1e6 : natural >= 1e4 ? 1e3 : 1;
	const scaled = natural / scale;
	const digits = scale === 1 ? 0 : scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
	const fmt = (v: number, sign: boolean) => {
		const x = v / scale;
		if (Math.abs(x) < 0.5 * 10 ** -digits) return '0';
		const t = fmtNum(Math.abs(x), digits);
		return sign ? `${x < 0 ? '−' : '+'}${t}` : x < 0 ? `−${t}` : t;
	};
	let run = 0;
	let max = 0;
	const bars = steps.map((s): WaterfallBar => {
		let from: number;
		let to: number;
		if (s.id === 'natural' || s.id === 'left') {
			from = 0;
			to = s.m3;
			run = s.m3;
		} else {
			from = run;
			to = run - s.m3;
			run = to;
		}
		max = Math.max(max, from, to);
		const value = s.id === 'natural' || s.id === 'left' ? fmt(s.m3, false) : fmt(-s.m3, true);
		return { id: s.id, label: s.label, short: SHORT[s.id], from, to, end: run, value };
	});
	return { bars, max, unit: scale === 1e6 ? 'million m³ a year' : scale === 1e3 ? 'thousand m³ a year' : 'm³ a year' };
}

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
	/** Its place in the record: "the driest third of years". */
	share: string;
	bounds: string;
	nYears: number;
	enoughYears: boolean;
	/** Null when there are too few years. */
	waterfall: WaterfallStep[] | null;
	/** Months (or days) below, baseline and this run, and the change ("+4", "−2", "0"); null when too few years. */
	below: { background: number; application: number; change: string; units: number } | null;
	verdict: LicenceImpactVerdict;
	verdictLabel: string;
	/** VERDICT_MARK: the verdict's direction, beside its words. */
	mark: string;
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
			/** The compared run as the board names it: "this run", "the application". */
			application: string;
			/** Complete water years classed. */
			nYears: number;
			method: LicenceImpact['method'];
			columns: BoardColumn[];
			/** What the board compares, as the mock-up's application table: the runs, the proposed use, the years, the requirement. */
			summary: { label: string; value: string }[];
			/** Existing use is the background run's own, and what existing *authorised* use needs. */
			existingNote: string;
			notes: string[];
	  }
	| { status: 'unavailable'; reason: string };

const m3 = (v: number) => `${fmtNum(v)} m³`;
const signed = (n: number) => (n > 0 ? `+${fmtNum(n)}` : n < 0 ? `−${fmtNum(-n)}` : '0');

function waterfallOf(c: LicenceImpactClass, background: string, authorised: boolean, application: string): WaterfallStep[] | null {
	const w = c.waterfall;
	if (!w) return null;
	const step = (id: WaterfallStep['id'], label: string, v: number): WaterfallStep => ({ id, label, m3: v, text: id === 'natural' || id === 'left' || Math.round(v) === 0 ? m3(Math.abs(v) < 0.5 ? 0 : v) : v < 0 ? `+${m3(-v)}` : `−${m3(v)}` });
	return [
		step('natural', 'Natural flow', w.naturalM3),
		step('existing', `${authorised ? 'Existing authorised use' : 'Existing use'} in ${background}`, w.existingUseM3),
		step('proposed', `Proposed use (${application} − baseline)`, w.proposedM3),
		step('other', 'Other: dams, storage, groundwater, land cover', w.otherM3),
		step('left', 'Flow left at the outlet', w.leftM3)
	];
}

/** What the board reads of each run: the impact report passes its compare response, the evidence report its two runs. */
export interface BoardRun {
	run: Pick<RunCompareResponse['a']['run'], 'label' | 'startDate' | 'summary'>;
}

export interface BoardInput {
	data: { a: BoardRun; b: BoardRun };
	series: ImpactSeries;
	method: YearClassMethod;
	/** The Reserve site (outcomes/matrix.ts chooseSite); the outlet by default. */
	site?: MatrixSite;
	/** What the compared run is called in the board's words: "this run" in the impact report, "the application" in the evidence report. */
	applicationName?: string;
}

/** The board for an impact report: its baseline as the background, this run as the application. */
export function buildLicenceImpactBoard(input: BoardInput): BoardView {
	const { a, b } = input.data;
	const application = input.applicationName ?? 'this run';
	if (!input.series.background.natural) return { status: 'unavailable', reason: UNAVAILABLE.noNaturalFlow };
	const notes: string[] = [];
	// A gauge needs its rule table in both runs; otherwise the outlet, said so (never the outlet's numbers in the gauge's name).
	let site = input.site ?? OUTLET_SITE;
	if (site.id !== null && ![a, b].every((s) => s.run.summary.ewrAssurance?.some((x) => x.nodeId === site.id))) {
		notes.push(siteFallbackNote(site.where, application));
		site = OUTLET_SITE;
	}
	let impact: LicenceImpact;
	const fa = a.run.summary.forecast?.from;
	const fb = b.run.summary.forecast?.from;
	try {
		impact = licenceImpactByYearClass({
			background: {
				startDate: a.run.startDate,
				summary: a.run.summary,
				series: [...toRunSeries('natural_flow', input.series.background.natural, fa), ...toRunSeries('ewr_shortfall', input.series.background.ewrShortfall, fa)]
			},
			application: { startDate: b.run.startDate, summary: b.run.summary, series: toRunSeries('ewr_shortfall', input.series.application.ewrShortfall, fb) },
			siteNodeId: site.id,
			yearClassMethod: input.method
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { status: 'unavailable', reason: /water account/.test(msg) ? UNAVAILABLE.noWaterAccount : /ewr_shortfall/.test(msg) ? UNAVAILABLE.noEwrShortfall : `${UNAVAILABLE.failed}: ${msg}` };
	}
	return boardOf(impact, { data: input.data, site, application, notes });
}

/** Why a board is missing, in words; `failed` is followed by the engine's message. */
const UNAVAILABLE: Readonly<Record<EvidenceLicenceImpactUnavailable, string>> = Object.freeze({
	notBuilt: 'This report was built without licence impact by year class.',
	noNaturalFlow: 'The baseline has no natural flow series, so its water years cannot be classed.',
	noWaterAccount: 'One of the runs was made before the engine kept a water account (engine 0.32.0). Run the model again to see this board.',
	noEwrShortfall: 'One of the runs has no EWR shortfall series, so its days below the EWR cannot be counted.',
	failed: 'The board could not be built'
});

const siteFallbackNote = (where: string, application: string) => `The baseline or ${application} has no Reserve results at ${where}, so the board reads the outlet.`;

/**
 * The evidence report's board (evidence-5): the engine built the numbers on
 * the server (evidence/impact.ts), so a draft and an issued pack's frozen
 * manifest word the same numbers; this only words them.
 */
export function evidenceBoard(li: EvidenceLicenceImpact, data: { a: BoardRun; b: BoardRun }): BoardView {
	const application = 'the application';
	if (li.result.status === 'unavailable') {
		const r = li.result;
		return { status: 'unavailable', reason: r.reason === 'failed' ? `${UNAVAILABLE.failed}: ${r.detail ?? 'unknown error'}` : UNAVAILABLE[r.reason] };
	}
	const site: MatrixSite = li.site ? { id: li.site.nodeId, label: `Gauge: ${li.site.name}`, where: `gauge ${li.site.name}` } : OUTLET_SITE;
	const asked = li.requestedSite;
	const notes = li.siteFellBack && asked ? [siteFallbackNote(asked.name ? `gauge ${asked.name}` : 'the chosen gauge', application)] : [];
	return boardOf(li.result.impact, { data, site, application, notes });
}

/** Words an engine board: the baseline as the background, `application` as the compared run. */
function boardOf(impact: LicenceImpact, ctx: { data: { a: BoardRun; b: BoardRun }; site: MatrixSite; application: string; notes: string[] }): BoardView {
	const { a, b } = ctx.data;
	const { site, application } = ctx;
	const notes = [...ctx.notes];
	const background = `“${a.run.label || 'Untitled run'}”`;
	const capitalised = application.charAt(0).toUpperCase() + application.slice(1);
	// A full-allocation background run (engine ≥ 1.18.0, settings.allocationMode, allocations.md; since issue #507 a scenario's, never the project's baseline) runs every holder at their registered volume: its use is existing *authorised* use.
	const mode = (r: typeof a) => r.run.summary.allocations?.mode ?? 'none';
	const authorised = mode(a) === 'fullAllocation';
	if (authorised && mode(b) !== 'fullAllocation')
		notes.push(`The baseline runs every holder at their full registered volume, but ${application} doesn’t, so the proposed step also counts the other holders going back to their modelled use. Run the application with the allocation mode at full allocation too.`);
	else if (!authorised && mode(b) === 'fullAllocation')
		notes.push(`${capitalised} holds every holder at their full registered volume, but the baseline doesn’t, so the proposed step also counts the other holders going up to their registered volumes. Compare it with a full-allocation baseline.`);
	const unit = impact.metric === 'reserveMonthsMet' ? 'months' : 'days';
	// Days below each run's own daily EWR (the pragmatic EWR, or a DRM table, engine ≥ 1.77.0), named as both runs have it.
	const dailyName = dailyEwrNameOf([a, b].map((r) => r.run.summary.catchment?.outletEwr));
	const names = { background: `the baseline ${background}`, application, ewr: dailyName };
	const columns: BoardColumn[] = impact.classes.map((c) => ({
		id: c.classId,
		label: c.label,
		share: CLASS_SHARE[impact.method][c.classId] ?? '',
		bounds: boundsText(c),
		nYears: c.nYears,
		enoughYears: c.enoughYears,
		waterfall: waterfallOf(c, `the baseline ${background}`, authorised, application),
		below: c.below ? { background: c.below.background, application: c.below.application, change: signed(c.below.change), units: c.below.units } : null,
		verdict: c.verdict,
		verdictLabel: VERDICT_LABEL[impact.metric][c.verdict],
		mark: VERDICT_MARK[c.verdict],
		text: describeLicenceImpact(impact.metric, c, names)
	}));
	notes.push(...impact.warnings);
	if (unit === 'days' && !impact.warnings.length) notes.push(`Neither run has a Reserve rule table at the outlet, so the board counts days below ${dailyName}.`);
	const classed = impact.classes.reduce((s, c) => s + c.nYears, 0);
	const belowLabel = impact.metric === 'reserveMonthsMet' ? `Months below the Reserve (the rule table at ${site.where})` : `Days below ${dailyName} at the outlet`;
	const proposed = impact.classes
		.filter((c) => c.waterfall)
		.map((c) => {
			const v = c.waterfall!.proposedM3;
			return `${c.label} ${Math.round(v) === 0 ? '0 m³' : v < 0 ? `−${m3(-v)}` : m3(v)}`;
		});
	return {
		status: 'ok',
		metric: impact.metric,
		belowLabel,
		background,
		application,
		nYears: classed,
		method: impact.method,
		columns,
		summary: [
			{ label: 'Baseline', value: background },
			{ label: capitalised, value: `“${b.run.label || 'Untitled run'}”` },
			{ label: 'Proposed use, mean a year', value: proposed.length ? proposed.join(' · ') : 'Not enough years in any class' },
			{ label: 'Years compared', value: `${classed} complete water ${classed === 1 ? 'year' : 'years'}, in ${impact.method} of the baseline’s natural flow` },
			{ label: 'Requirement', value: belowLabel }
		],
		existingNote: authorised
			? `Existing authorised use is the use in the baseline ${background}, a full-allocation run: every holder at their full registered volume, irrigation and other water users, less what returns to the river.`
			: `Existing use is the use in the baseline ${background} as that run modelled it: irrigation and other water users, less what returns to the river. For existing authorised use, compare with a baseline run at every holder’s full registered volume (a scenario that sets the allocation mode to full allocation: licence data never drives the project’s own baseline).`,
		notes
	};
}
