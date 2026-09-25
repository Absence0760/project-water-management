// Pure builders for a run's CSV exports: column order for the daily table and
// the multi-block summary sheet. Unit-tested in run-tables.test.ts.
import {
	demandPctNote,
	DOUBLE_MASS_MIN_DAYS,
	DOUBLE_MASS_MIN_YEARS,
	EQUITABLE_SHARE_FOOTNOTE,
	FARM_COLUMNS as FARM_DAILY_COLUMNS,
	GAUGE_COLUMNS,
	USER_COLUMNS,
	type RunSummary,
	type WaterBalanceRow,
	type Wr2012FlagLevel,
	type Wr2012Scaling
} from '@water-management/engine';
import type { RunEvidence } from '../runs/evidence.js';
import { csvRow } from './csv.js';

/**
 * Column order for daily exports: the order the engine emits series in
 * (packages/engine/src/run.ts), so the file reads like the workbook sheets.
 * run_series has no ordinal column, so the order lives here; keys the engine
 * adds later go after these, alphabetically. Node and catchment series share
 * some keys (`ewr`, `ewr_shortfall`), hence one order per scope.
 */
const CATCHMENT_ORDER = [
	'natural_flow',
	'simulated_outflow',
	'observed_flow',
	'ewr',
	'ewr_shortfall',
	'ewr_charged',
	'ewr_natural',
	'rain_used',
	'rain_final',
	'rain_chirps',
	'rain_chirps_corrected',
	'chirps_factor',
	'is_summer',
	'rain_flow',
	'base_flow',
	'response_flow',
	'resultant_flow'
];
// A farm's columns in FarmTemplate order (F … AB), intermediate ones included
// (engine ≥ 0.12.0), so the file reads left to right like the formulas.
const NODE_ORDER = FARM_DAILY_COLUMNS.map((c) => c.key);
const rank = (keys: string[]) => new Map(keys.map((k, i) => [k, i]));
const RANK = { catchment: rank(CATCHMENT_ORDER), node: rank(NODE_ORDER) };

/** Sort comparator for series keys of the catchment or of one node. */
export function seriesKeyOrder(scope: 'catchment' | 'node') {
	const r = RANK[scope];
	return (a: string, b: string): number => {
		const ra = r.get(a) ?? Infinity;
		const rb = r.get(b) ?? Infinity;
		return ra !== rb ? ra - rb : a.localeCompare(b);
	};
}

/**
 * Header of one node daily column: the label, the FarmTemplate (or
 * GaugeTemplate) column letter in brackets, then the unit, e.g.
 * "Irrigation supplied [G] (m³/day)". The summary CSV's column guide gives
 * each letter's formula.
 */
export function nodeColumnHeader(key: string, label: string, unit: string | null | undefined, kind: 'farm' | 'gauge' | 'user'): string {
	const letter = (kind === 'gauge' ? GAUGE_COLUMNS : kind === 'user' ? USER_COLUMNS : FARM_DAILY_COLUMNS).find((c) => c.key === key)?.letter;
	const withLetter = letter ? `${label} [${letter}]` : label;
	return unit ? `${withLetter} (${unit})` : withLetter;
}

export interface SummaryMeta {
	projectName: string;
	runLabel: string;
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	/** The modeller's written explanation of the run (007_run_notes); '' or absent = none. */
	notes?: string;
	/** When and by whom the notes last changed (ISO timestamp, display name). */
	notesUpdatedAt?: string | null;
	notesUpdatedBy?: string | null;
	/** The run's place in the evidence history (010_run_nomination); null or absent = never nominated. */
	evidence?: RunEvidence | null;
}

/**
 * Engine fractions (0–1) are written as percentages, the way the UI and the
 * workbook's Shortfalls sheet show them. Trimmed to 12 significant digits so
 * binary noise (0.07 × 100 = 7.000000000000001) doesn't reach the sheet.
 */
const pct = (v: unknown): unknown => (typeof v === 'number' ? Number((v * 100).toPrecision(12)) : v);
/** Fields converted with `pct` (the engine's own key names). */
const PERCENT_KEYS = new Set(['fractionSupplied', 'ewrFractionDaysNotMet']);

const FARM_COLUMNS: [key: string, header: string][] = [
	['avgCropRequirementM3Day', 'Average crop water requirement (m³/day)'],
	['avgDemandM3Day', 'Average abstraction demand (m³/day)'],
	['avgSuppliedM3Day', 'Average supplied (m³/day)'],
	['avgDeficitM3Day', 'Average deficit (m³/day)'],
	['fractionSupplied', 'Demand supplied (%)'],
	// Engine ≥ 0.17.0: the EWR charge at the EWR sites (audit Q17); older runs: the reach shortfall AB.
	['avgEwrShortfallM3Day', 'Average EWR charge (m³/day)'],
	['daysEwrNotMet', 'Days charged for the EWR']
];

/** Farm summary columns only some runs have (a feature's own), labelled when present (WP-1.34). */
const OPTIONAL_FARM_LABELS: Record<string, string> = {
	avgGroundwaterM3Day: 'Average groundwater pumped (m³/day)',
	avgBaseflowDepletionM3Day: 'Average stream depletion (m³/day)'
};

const CATCHMENT_ROWS: Record<string, string> = {
	meanNaturalFlowM3Day: 'Mean natural flow (m³/day)',
	meanSimulatedOutflowM3Day: 'Mean simulated outflow (m³/day)',
	ewrDaysNotMet: 'Days EWR not met at the outflow gauge',
	ewrFractionDaysNotMet: 'Days EWR not met at the outflow gauge (%)'
};

const CALIBRATION_ROWS: Record<string, string> = {
	days: 'Days with observed and simulated flow',
	nse: 'NSE',
	pbias: 'PBIAS (%)',
	rmseM3s: 'RMSE (m³/s)',
	meanObservedM3s: 'Mean observed flow (m³/s)',
	meanSimulatedM3s: 'Mean simulated flow (m³/s)'
};

type Cell = string | number | null;
/** Scalars only: nested values (future arrays/objects) are skipped, not stringified. */
const scalar = (v: unknown): Cell | undefined =>
	typeof v === 'number' || typeof v === 'string' || v === null ? v : undefined;

/** Known keys with friendly labels first, then any extra scalar fields under their raw key. */
function labelledRows(obj: Record<string, unknown>, labels: Record<string, string>): [string, Cell][] {
	const out: [string, Cell][] = [];
	for (const [k, label] of Object.entries(labels)) {
		if (k in obj) out.push([label, scalar(PERCENT_KEYS.has(k) ? pct(obj[k]) : obj[k]) ?? null]);
	}
	for (const [k, v] of Object.entries(obj)) {
		const s = scalar(v);
		if (!(k in labels) && s !== undefined) out.push([k, s]);
	}
	return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Water-year order (Oct … Sep), as the app's monthly settings and the run warning list them. */
const WY_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const SOURCE_TEXT = { month: 'own month', pooled: 'pooled (all months)' } as const;

/** The 12 CHIRPS bias factors the run applied (model.md §2.4b), one row per calendar month. */
export function* chirpsFactorLines(c: RunSummary['chirpsCorrection']): Generator<string> {
	yield csvRow(['CHIRPS bias correction']);
	if (c === undefined) {
		yield csvRow(['Run made before engine 0.7.0: CHIRPS used as uploaded']);
		return;
	}
	if (c === null) {
		yield csvRow(['No CHIRPS series — nothing to correct']);
		return;
	}
	if (c.mode === 'none') {
		yield csvRow(["Setting 'none': CHIRPS used as uploaded"]);
		return;
	}
	yield csvRow(['Month', 'Factor applied', 'Source', 'Own factor', 'Clamped', 'Shared days', 'Catchment rain on them (mm)', 'CHIRPS on them (mm)', 'Days CHIRPS filled in']);
	for (const m of WY_MONTHS) {
		const f = c.months[m - 1]!;
		yield csvRow([
			MONTH_NAMES[m - 1]!,
			f.factor,
			f.source ? SOURCE_TEXT[f.source] : 'none (CHIRPS used as uploaded)',
			f.ownFactor,
			f.clamped ? 'yes' : 'no',
			f.days,
			f.catchmentMm,
			f.chirpsMm,
			f.fallbackDays
		]);
	}
	yield csvRow(['Pooled', c.pooled.factor, 'all months together', c.pooled.ownFactor, c.pooled.clamped ? 'yes' : 'no', c.pooled.days, c.pooled.catchmentMm, c.pooled.chirpsMm, c.fallbackDays]);
	if (c.excludedWaterYears.length) yield csvRow(['Water years left out of the fit', c.excludedWaterYears.join(' ')]);
	// Engine ≥ 0.18.0: why, and the days left out one by one (absent on older runs).
	if (c.lowVsChirpsYears?.length) yield csvRow(['of which far below CHIRPS', c.lowVsChirpsYears.join(' ')]);
	for (const d of c.doubtfulKeepDry ?? []) {
		yield csvRow(['of which a kept-dry run CHIRPS contradicts', d.waterYears.join(' '), `${d.start} to ${d.end}`, d.days, 'CHIRPS on the kept-dry days (mm)', d.chirpsMm, 'limit (mm)', d.limitMm]);
	}
	if (c.flaggedDaysLeftOut) yield csvRow(['Days of flagged zero runs left out (treated as missing)', c.flaggedDaysLeftOut]);
	if (c.missingDaysLeftOut) yield csvRow(['Days listed as missing left out', c.missingDaysLeftOut]);
	if (c.keptDryDaysInFit) yield csvRow(['Kept-dry days kept in the fit', c.keptDryDaysInFit]);
}

/**
 * The double-mass check of catchment rain against CHIRPS (engine ≥ 0.18.0,
 * model.md §2.10a): whole-record slope, the segments between reported
 * breaks, the breaks, then one row per judged water year.
 */
export function* doubleMassLines(dm: NonNullable<RunSummary['dataQuality']>['doubleMass']): Generator<string> {
	yield csvRow(['Double-mass check: catchment rain vs CHIRPS']);
	if (dm === undefined) {
		yield csvRow(['Run made before engine 0.18.0: no double-mass check']);
		return;
	}
	if (dm === null) {
		yield csvRow([`Not checked: needs catchment rain and CHIRPS with at least ${DOUBLE_MASS_MIN_YEARS} water years of ${DOUBLE_MASS_MIN_DAYS}+ shared days`]);
		return;
	}
	yield csvRow(['Whole-record slope: catchment / CHIRPS (×)', dm.wholeSlope]);
	yield csvRow(['Segment from water year', 'to water year', 'Years', 'Shared days', 'Slope (×)']);
	for (const s of dm.segments) yield csvRow([s.fromWaterYear, s.toWaterYear, s.years, s.days, s.slope]);
	if (dm.breaks.length) {
		yield csvRow(['Break after water year', 'Slope before (×)', 'Slope after (×)', 'Change (%)', 'Pettitt p', 'BIC gain']);
		for (const b of dm.breaks) yield csvRow([b.afterWaterYear, b.slopeBefore, b.slopeAfter, b.change * 100, b.pettittP, b.bicGain]);
	} else {
		yield csvRow(['No break found']);
	}
	yield csvRow(['Water year', 'Shared days', 'Catchment rain (mm)', 'CHIRPS (mm)', 'Ratio (×)', 'Cumulative catchment (mm)', 'Cumulative CHIRPS (mm)', 'Residual (%)']);
	for (const y of dm.years) yield csvRow([y.waterYear, y.days, y.catchmentMm, y.chirpsMm, y.ratio, y.cumCatchmentMm, y.cumChirpsMm, y.residualPct]);
	if (dm.skippedYears.length) yield csvRow(['Water years too short to judge', dm.skippedYears.join(' ')]);
}

/** Catchment rain the run treated as missing (engine ≥ 0.15.0, model.md §2.4c, CR-20), one row per period. */
export function* zeroRainLines(z: RunSummary['zeroRainInfill']): Generator<string> {
	yield csvRow(['Catchment rain treated as missing']);
	if (z === undefined) {
		yield csvRow(['Run made before engine 0.15.0: flagged zero-rain runs ran as recorded (dry)']);
		return;
	}
	if (z === null) {
		yield csvRow(['No catchment rain series']);
		return;
	}
	yield csvRow(['Flagged zero runs', z.mode === 'missing' ? 'treated as missing' : 'run as recorded (dry)']);
	if (z.asRecordedDays > 0) yield csvRow(['Days of flagged runs run as recorded', z.asRecordedDays]);
	if (z.periods.length) {
		yield csvRow(['Start', 'End', 'Source', 'Reason', 'Days set aside', 'Catchment rain recorded (mm)', 'Rain used instead (mm)', 'Days with nothing to fill them']);
		for (const p of z.periods) {
			yield csvRow([p.start, p.end, p.source === 'flagged' ? 'flagged zero run' : 'listed in settings', p.reason ?? '', p.days, p.recordedMm, p.filledMm, p.unfilledDays]);
		}
		yield csvRow(['Total', '', '', '', z.days, z.recordedMm, z.filledMm, z.unfilledDays]);
	} else {
		yield csvRow(['No days set aside']);
	}
	for (const k of z.keptDry) yield csvRow(['Kept as recorded (dry)', k.start, k.end, k.reason, k.days]);
}

/**
 * Whether the run is the project's nominated evidence run (010_run_nomination):
 * always a status row, then this run's nomination (when, who, why) and, for a
 * replaced one, what replaced it. A reader of the sheet alone can tell a run
 * the project stands behind from one it has moved away from.
 */
export function* evidenceLines(e: RunEvidence | null): Generator<string> {
	if (!e) {
		yield csvRow(['Evidence nomination', 'not nominated']);
		return;
	}
	yield csvRow(['Evidence nomination', e.status === 'current' ? 'the nominated evidence run' : 'nominated before, since replaced']);
	yield csvRow(['Nominated', e.nominatedAt, e.nominatedBy ?? '', e.reason]);
	if (e.replacedBy) yield csvRow(['Replaced by', e.replacedBy.runLabel || 'Untitled run', e.replacedBy.nominatedAt, e.replacedBy.nominatedBy ?? '', e.replacedBy.reason]);
}

/**
 * The run summary as one CSV sheet of blocks separated by a blank line: run
 * details, the per-farm table, the catchment figures, the CHIRPS bias factors,
 * the catchment rain treated as missing, the double-mass check, calibration,
 * the WR2012 check, the column guide, warnings. The run details carry the run notes.
 * Fields the engine adds to the summary later still appear (under their key).
 */
export function* summaryCsvLines(meta: SummaryMeta, summary: RunSummary): Generator<string> {
	yield csvRow(['Project', meta.projectName]);
	yield csvRow(['Run', meta.runLabel]);
	yield csvRow(['Run created', meta.createdAt]);
	yield csvRow(['Engine version', meta.engineVersion]);
	yield csvRow(['Period start', meta.startDate]);
	yield csvRow(['Period end', meta.endDate]);
	// Always written, so the row is there (empty) for a reader looking for it.
	yield csvRow(['Run notes', meta.notes ?? '']);
	if (meta.notes && meta.notesUpdatedAt) yield csvRow(['Notes last changed', meta.notesUpdatedAt, meta.notesUpdatedBy ?? '']);
	yield* evidenceLines(meta.evidence ?? null);
	yield '';

	yield* verificationLines(summary.verification);
	yield '';

	yield csvRow(['Farm summary']);
	const farms = summary.farms as unknown as Record<string, unknown>[];
	const known = new Set(['nodeId', 'name', ...FARM_COLUMNS.map(([k]) => k)]);
	const extra = [...new Set(farms.flatMap((f) => Object.keys(f)))].filter(
		(k) => !known.has(k) && farms.some((f) => scalar(f[k]) !== undefined)
	);
	yield csvRow(['Farm', ...FARM_COLUMNS.map(([, h]) => h), ...extra.map((k) => OPTIONAL_FARM_LABELS[k] ?? k)]);
	for (const f of farms) {
		yield csvRow([
			String(f.name ?? ''),
			...FARM_COLUMNS.map(([k]) => scalar(PERCENT_KEYS.has(k) ? pct(f[k]) : f[k]) ?? null),
			...extra.map((k) => scalar(f[k]) ?? null)
		]);
	}
	yield '';

	yield csvRow(['Catchment']);
	for (const row of labelledRows(summary.catchment as unknown as Record<string, unknown>, CATCHMENT_ROWS)) yield csvRow(row);
	yield '';

	yield* curtailmentLines(summary.curtailment);
	if (summary.landCover) {
		yield '';
		yield* landCoverLines(summary.landCover);
	}
	if (summary.users?.length || summary.curtailment?.otherUsers?.length) {
		yield '';
		yield* otherUserLines(summary);
	}
	yield '';

	yield* ewrSiteLines(summary.curtailment);
	yield '';

	yield* waterBalanceLines(summary.waterBalance);
	yield '';

	yield* chirpsFactorLines(summary.chirpsCorrection);
	yield '';

	yield* zeroRainLines(summary.zeroRainInfill);
	yield '';

	yield* doubleMassLines(summary.dataQuality ? summary.dataQuality.doubleMass : undefined);
	yield '';

	yield csvRow(['Calibration (outflow gauge vs observed)']);
	if (summary.calibration) {
		for (const row of labelledRows(summary.calibration as unknown as Record<string, unknown>, CALIBRATION_ROWS)) {
			yield csvRow(row);
		}
	} else {
		yield csvRow(['No observed flow series — calibration not computed']);
	}
	yield '';

	yield* wr2012Lines(summary.wr2012, meta.notes ?? '');
	yield '';

	yield* columnGuideLines();

	if (summary.warnings.length) {
		yield '';
		yield csvRow(['Warnings']);
		for (const w of summary.warnings) yield csvRow([w]);
	}
}

type Curtailment = NonNullable<RunSummary['curtailment']>;
type CurtailmentRow = Curtailment['farms'][number];

/** The curtailment table's columns (model.md §2.11), workbook letter in brackets where it has one. Unrounded. */
const CURTAILMENT_COLUMNS: [header: string, value: (f: CurtailmentRow, siteName: (id: string) => string) => Cell][] = [
	['Average demand [H] (m³/day)', (f) => f.demandM3Day],
	['Average supplied [I] (m³/day)', (f) => f.suppliedM3Day],
	['Deficit [J] (m³/day)', (f) => f.deficitM3Day],
	['Supplied [K] (% of demand)', (f) => pct(f.fractionSupplied) as Cell],
	// Q11 (engine ≥ 0.17.0 labels): the equitable share is a fairness benchmark, never water a farm may "gain".
	['Equitable share volume [M] (m³/day)', (f) => f.targetM3Day],
	['Above (−) / below (+) equitable share [N] (m³/day)', (f) => f.reduceGainM3Day],
	['Above (−) / below (+) equitable share [O] (l/s)', (f) => f.reduceGainLs],
	['Equitable share [P] (% of demand)', (f) => pct(f.targetFraction) as Cell],
	['EWR charge [R] (m³/day)', (f) => f.ewrShortfallM3Day],
	['EWR charge met by irrigating less (m³/day)', (f) => f.ewrChargeIrrigationM3Day ?? null],
	['EWR charge met by storing less / passing inflow (m³/day)', (f) => f.ewrChargeStorageM3Day ?? null],
	['Supply cut for the EWR (m³/day)', (f) => f.ewrSupplyCutM3Day ?? null],
	['Supply cut for the EWR (l/s)', (f) => f.ewrSupplyCutLs ?? null],
	['EWR site setting the charge', (f, site) => (f.ewrBindingSiteId ? site(f.ewrBindingSiteId) : '')],
	['Total change [S] (m³/day)', (f) => f.totalChangeM3Day],
	['Total change [T] (l/s)', (f) => f.totalChangeLs],
	['Volume left [U] (m³/day)', (f) => f.volumeLeftM3Day],
	['Demand left [V] (%)', (f) => pct(f.fractionOfDemandLeft) as Cell],
	// Why V is empty or not meaningful (audit Q13): no_demand | below_floor (demand under DEMAND_PCT_FLOOR_M3_DAY) | empty.
	['demand_pct_note', (f) => demandPctNote(f.demandM3Day)],
	['EWR cut beyond equitable share (m³/day)', (f) => f.ewrCutBeyondShareM3Day ?? null]
];

/**
 * The curtailment report over its reporting window (model.md §2.11), one row
 * per farm plus the totals, every number unrounded. From engine 0.17.0 the
 * EWR column is the farm's charge at the EWR sites (audit Q17), a header
 * row names the rule, and the fixed footnote closes the table (Q11).
 */
export function* curtailmentLines(c: RunSummary['curtailment']): Generator<string> {
	yield csvRow(['Curtailment targets']);
	if (!c) {
		yield csvRow(['Run made before engine 0.3.0: no curtailment report. Run it again to see it.']);
		return;
	}
	yield csvRow(['Reporting window', c.reportStart, c.reportEnd, `${c.days} days`]);
	yield csvRow(['Equitable share of supply (fairness benchmark) [K total] (%)', pct(c.equitableFraction) as Cell]);
	yield csvRow([
		'EWR attribution',
		c.ewrAttribution === 'netImpactProRata'
			? `net impact pro rata (Q17), sites: outlet + gauges (${(c.ewrSites ?? []).length})`
			: 'run made before engine 0.17.0: incremental shortfall (workbook AB)'
	]);
	const names = new Map((c.ewrSites ?? []).map((s) => [s.nodeId, s.name]));
	for (const f of c.farms) if (!names.has(f.nodeId)) names.set(f.nodeId, f.name);
	const site = (id: string) => names.get(id) ?? id;
	yield csvRow(['Farm', ...CURTAILMENT_COLUMNS.map(([h]) => h)]);
	for (const f of c.farms) yield csvRow([f.name, ...CURTAILMENT_COLUMNS.map(([, v]) => v(f, site))]);
	const t = c.totals;
	yield csvRow([
		'Total',
		t.demandM3Day,
		t.suppliedM3Day,
		t.deficitM3Day,
		pct(c.equitableFraction) as Cell,
		t.targetM3Day,
		t.reduceGainM3Day,
		t.reduceGainLs,
		'',
		t.ewrShortfallM3Day,
		t.ewrChargeIrrigationM3Day ?? null,
		t.ewrChargeStorageM3Day ?? null,
		t.ewrSupplyCutM3Day ?? null,
		'',
		'',
		t.totalChangeM3Day,
		'',
		t.volumeLeftM3Day,
		'',
		'',
		t.ewrCutBeyondShareM3Day ?? null
	]);
	yield csvRow([EQUITABLE_SHARE_FOOTNOTE]);
}

/** Each EWR site over the reporting window (engine ≥ 0.17.0, audit Q17): charged + natural = shortfall. */
export function* ewrSiteLines(c: RunSummary['curtailment']): Generator<string> {
	yield csvRow(['EWR sites (reporting window)']);
	if (!c?.ewrSites) {
		yield csvRow(['Run made before engine 0.17.0: the EWR was assessed farm by farm (workbook AB), not at sites.']);
		return;
	}
	yield csvRow(['Site', 'Outlet', 'Farms upstream', 'Days not met', 'Average shortfall (m³/day)', 'Charged to farms (m³/day)', 'Natural (m³/day)']);
	for (const s of c.ewrSites) yield csvRow([s.name, s.isOutlet ? 'yes' : 'no', s.farmCount, s.daysNotMet, s.shortfallM3Day, s.chargedM3Day, s.naturalM3Day]);
}

/** The engine's self-checks on the run (engine ≥ 0.12.0, model.md §6 "Verification"). */
export function* verificationLines(v: RunSummary['verification']): Generator<string> {
	yield csvRow(['Self-checks']);
	if (!v) {
		yield csvRow(['Run made before engine 0.12.0: no self-checks recorded. Run it again to check it.']);
		return;
	}
	yield csvRow(['All passed', v.passed ? 'yes' : 'NO']);
	yield csvRow(['Check', 'Result', 'First problem found']);
	for (const c of v.checks) yield csvRow([c.label, c.passed ? 'passed' : 'FAILED', c.detail ?? '']);
	if (v.maxResidual) {
		yield csvRow(['Largest daily balance check [V] (m³/day)', v.maxResidual.valueM3Day, `${v.maxResidual.name} on ${v.maxResidual.date}`]);
	}
}

/** A column marked optional appears only when some row has it (a term only some networks have, WP-1.33–1.35). */
const BALANCE_COLUMNS: [header: string, value: (r: WaterBalanceRow) => number | null, optional?: true][] = [
	['Days', (r) => r.days],
	['Rain (mm)', (r) => r.rainMm],
	['Natural flow (mm)', (r) => r.naturalFlowMm],
	['Runoff coefficient', (r) => r.runoffCoefficient],
	['Actual evaporation (mm)', (r) => r.runoff?.aetMm ?? null],
	['Groundwater exchange (mm)', (r) => r.runoff?.exchangeMm ?? null],
	['Change in runoff-model storage (mm)', (r) => r.runoff?.storageChangeMm ?? null],
	['Runoff-model residual (mm)', (r) => r.runoff?.residualMm ?? null],
	['Natural flow (m³)', (r) => r.naturalFlowM3],
	['Farm runoff (m³)', (r) => r.farmRunoffM3],
	['Dam storage at start (m³)', (r) => r.openingStorageM3],
	['Irrigation abstraction demand (m³)', (r) => r.demandM3],
	['Irrigation supplied (m³)', (r) => r.suppliedM3],
	['Return flow (m³)', (r) => r.returnFlowM3],
	['Consumptive use (m³)', (r) => r.consumptiveUseM3],
	['Transfers, net (m³)', (r) => r.transfersM3],
	['Rain on dams (m³)', (r) => r.rainOnDamsM3 ?? null],
	['Dam evaporation (m³)', (r) => r.damEvaporationM3 ?? null],
	['Other users’ use: taken − returned (m³)', (r) => r.otherUseM3 ?? null, true],
	['Groundwater pumped (m³)', (r) => r.groundwaterM3 ?? null, true],
	['Stream depletion from pumping (m³)', (r) => r.streamDepletionM3 ?? null, true],
	['Runoff removed by land cover (m³)', (r) => r.landCoverReductionM3 ?? null, true],
	['Spill (m³)', (r) => r.spillM3],
	['Outflow (m³)', (r) => r.outflowM3],
	['Dam storage at end (m³)', (r) => r.closingStorageM3],
	['Residual (m³)', (r) => r.residualM3]
];

/**
 * Where the water went, one row per water year and one for the run (engine ≥
 * 0.12.0). The network closes: start storage + farm runoff + transfers +
 * rain on dams = consumptive use + dam evaporation + outflow + end storage +
 * residual (the dam terms from engine 0.16.0; blank on older runs).
 */
export function* waterBalanceLines(wb: RunSummary['waterBalance']): Generator<string> {
	yield csvRow(['Water balance by water year (Oct–Sep)']);
	if (!wb) {
		yield csvRow(['Run made before engine 0.12.0: no water balance recorded. Run it again to see it.']);
		return;
	}
	yield csvRow(['Start storage + farm runoff + transfers + rain on dams = consumptive use + dam evaporation + outflow + end storage + residual; the residual should be 0']);
	const rows = [...wb.years, wb.total];
	const cols = BALANCE_COLUMNS.filter(([, f, optional]) => !optional || rows.some((r) => f(r) !== null));
	yield csvRow(['Water year', ...cols.map(([h]) => h)]);
	for (const r of rows) {
		const year = r.waterYear === null ? 'Whole run' : `${r.waterYear}/${String((r.waterYear + 1) % 100).padStart(2, '0')}`;
		yield csvRow([year, ...cols.map(([, f]) => f(r))]);
	}
}

const WR2012_FLAG_TEXT: Record<Wr2012FlagLevel, string> = {
	ok: 'within the note threshold',
	note: 'note the difference',
	query: 'query',
	unusable: 'not usable for EWR findings'
};
const SCALING_TEXT: Record<Wr2012Scaling, string> = { area: 'area ratio', areaRain: 'area and rainfall ratio' };
/** Water year labelled by the calendar year it starts in: 2001 → "2001/02". */
const waterYearText = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;

/**
 * The WR2012 check (model.md §2.10c): reference, scaling, the MAR ratios over
 * the overlapping years and the whole run, the 12 monthly means, the dry
 * season, the pattern correlation and the flag. A query or not-usable flag
 * says whether the run carries a written explanation (the run notes, in the
 * run details block at the top).
 */
export function* wr2012Lines(w: RunSummary['wr2012'], notes: string): Generator<string> {
	yield csvRow(['WR2012 check: simulated natural flow vs WR2012 naturalised flow']);
	if (!w) {
		yield csvRow(['Not checked: no WR2012 reference in the settings the run used']);
		return;
	}
	yield csvRow(['Quaternary', w.quaternary]);
	yield csvRow(['Source', w.source]);
	yield csvRow(['Reference period (water years)', waterYearText(w.referencePeriod.start), waterYearText(w.referencePeriod.end)]);
	const s = w.scaling;
	const fell = s.rule !== s.requested ? ` (${SCALING_TEXT[s.requested]} asked for; its data is missing)` : '';
	yield csvRow(['Scaling', `${SCALING_TEXT[s.rule]}${fell}`]);
	yield csvRow(['Scaling factor', s.factor]);
	yield csvRow(['Area factor', s.areaFactor, 'Modelled area (km²)', s.modelAreaKm2, 'Quaternary area (km²)', s.referenceAreaKm2]);
	yield csvRow(['Rainfall factor', s.rainFactor, 'Modelled MAP (mm)', s.modelMapMm, 'Quaternary MAP (mm)', s.referenceMapMm]);
	yield csvRow(['WR2012 MAR (Mm³/a)', w.referenceMarMm3]);
	yield csvRow(['WR2012 MAR scaled to the modelled catchment (Mm³/a)', w.scaledMarMm3]);
	yield csvRow(['Over', 'Water years', 'Simulated natural MAR (Mm³/a)', 'Scaled WR2012 MAR (Mm³/a)', 'Ratio (simulated ÷ WR2012)']);
	if (w.overlap) {
		const y = w.overlap.years;
		yield csvRow(['Overlapping years', `${waterYearText(y[0]!)} to ${waterYearText(y[y.length - 1]!)} (${y.length})`, w.overlap.simulatedMarMm3, w.scaledMarMm3, w.overlap.ratio]);
	} else {
		yield csvRow(['Overlapping years', 'no complete water year inside the reference period']);
	}
	yield csvRow(['Whole run', `${w.whole.days} days`, w.whole.simulatedMarMm3, w.scaledMarMm3, w.whole.ratio]);
	yield csvRow([`Monthly means over ${w.monthlyBasis === 'overlap' ? 'the overlapping years' : 'the whole run'} (Mm³ per month)`]);
	yield csvRow(['Month', 'Simulated natural (Mm³)', 'Scaled WR2012 (Mm³)', 'Ratio', 'Dry season']);
	for (const m of w.months) yield csvRow([MONTH_NAMES[m.month - 1]!, m.simulatedMm3, m.referenceMm3, m.ratio, m.lowFlow ? 'yes' : 'no']);
	yield csvRow([
		'Dry-season ratio',
		w.lowFlowRatio,
		w.lowFlowMonths.map((m) => MONTH_NAMES[m - 1]).join(' '),
		w.lowFlowSource === 'setting' ? 'months set in Settings' : 'the months the run’s natural flow is lowest'
	]);
	yield csvRow(['Monthly pattern correlation (Pearson r)', w.patternCorrelation]);
	const f = w.flag;
	yield csvRow(['Flag', WR2012_FLAG_TEXT[f.level], 'judged on', f.basis === 'overlap' ? 'the overlapping years' : 'the whole run', 'Deviation (%)', f.deviationPct]);
	yield csvRow([
		'Thresholds (%)',
		'note',
		f.thresholds.notePct,
		'query',
		f.thresholds.queryPct,
		'query if wetter by',
		f.thresholds.queryWetterPct,
		'not usable',
		f.thresholds.unusablePct
	]);
	if (f.text) yield csvRow(['Flag detail', f.text]);
	if (f.level === 'query' || f.level === 'unusable') {
		yield csvRow(['Written explanation', notes ? 'see Run notes at the top of this file' : 'none recorded for this run']);
	}
}

/** What each farm daily column means: its FarmTemplate letter and formula (verify/columns.ts). */
export function* columnGuideLines(): Generator<string> {
	yield csvRow(['Farm daily columns (the daily CSV of a farm)']);
	yield csvRow(['Column', 'Series', 'Formula']);
	for (const c of FARM_DAILY_COLUMNS) yield csvRow([c.letter ?? '', c.key, c.formula]);
}

/**
 * Other water users (engine ≥ 0.22.0, WP-1.33): the whole-run means, then the
 * reporting window's EWR charge and whether it is curtailed (a senior user is
 * not; docs/model.md §2.11). Only in runs that have users.
 */
export function* otherUserLines(summary: RunSummary): Generator<string> {
	yield csvRow(['Other water users (whole run)']);
	yield csvRow(['User', 'Priority', 'Average demand (m³/day)', 'Average taken (m³/day)', 'Average deficit (m³/day)', 'Demand supplied (%)', 'Average returned (m³/day)', 'Average EWR charge (m³/day)', 'Days charged for the EWR']);
	for (const u of summary.users ?? []) {
		yield csvRow([u.name, u.priority, u.avgDemandM3Day, u.avgSuppliedM3Day, u.avgDeficitM3Day, pct(u.fractionSupplied) as Cell, u.avgReturnedM3Day, u.avgEwrChargeM3Day, u.daysEwrNotMet]);
	}
	const rows = summary.curtailment?.otherUsers ?? [];
	if (!rows.length) return;
	yield '';
	yield csvRow(['Other water users: EWR charge and curtailment (reporting window)']);
	yield csvRow(['User', 'Priority', 'Demand (m³/day)', 'Taken (m³/day)', 'Returned (m³/day)', 'EWR charge (m³/day)', 'Curtailed', 'Supply cut (m³/day)', 'Supply cut (l/s)', 'Charge not removed by a cut (m³/day)']);
	for (const r of rows) {
		yield csvRow([r.name, r.priority, r.demandM3Day, r.suppliedM3Day, r.returnedM3Day, r.ewrChargeM3Day, r.curtailed ? 'yes' : 'no (senior)', r.supplyCutM3Day, r.supplyCutLs, r.uncurtailedChargeM3Day]);
	}
	yield csvRow(['Other water users are outside the irrigation equitable-share benchmark. A senior user is not curtailed for the EWR: its charge stands, and is not moved onto the farms.']);
}

/**
 * Land-cover streamflow reductions (engine ≥ 0.24.0, WP-1.35): the low-flow
 * threshold, the total, and per class its condensed area, mean reduction and
 * mm/yr over that area. Only in runs with land cover.
 */
export function* landCoverLines(lc: NonNullable<RunSummary['landCover']>): Generator<string> {
	yield csvRow(['Land-cover streamflow reductions (invasive plants and forestry)']);
	yield csvRow(['Low-flow threshold: natural flow exceeded 75 % of days (m³/day)', lc.lowFlowThresholdM3Day]);
	yield csvRow(['Mean reduction (m³/day)', lc.reductionM3Day]);
	yield csvRow(['Share of natural flow (%)', pct(lc.fractionOfNatural) as Cell]);
	yield csvRow(['Cover class', 'Condensed area (km²)', 'Mean reduction (m³/day)', 'Reduction over the condensed area (mm/yr)']);
	for (const c of lc.byClass) yield csvRow([c.coverClass, c.condensedKm2, c.reductionM3Day, c.mmPerYear]);
}
