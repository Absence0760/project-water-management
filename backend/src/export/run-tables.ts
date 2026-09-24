// Pure builders for a run's CSV exports: column order for the daily table and
// the multi-block summary sheet. Unit-tested in run-tables.test.ts.
import {
	DOUBLE_MASS_MIN_DAYS,
	DOUBLE_MASS_MIN_YEARS,
	FARM_COLUMNS as FARM_DAILY_COLUMNS,
	GAUGE_COLUMNS,
	type RunSummary,
	type WaterBalanceRow
} from '@water-management/engine';
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
export function nodeColumnHeader(key: string, label: string, unit: string | null | undefined, kind: 'farm' | 'gauge'): string {
	const letter = (kind === 'gauge' ? GAUGE_COLUMNS : FARM_DAILY_COLUMNS).find((c) => c.key === key)?.letter;
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
	['avgEwrShortfallM3Day', 'Average EWR shortfall (m³/day)'],
	['daysEwrNotMet', 'Days EWR not met']
];

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
	// Engine ≥ 0.17.0: why, and the days left out one by one (absent on older runs).
	if (c.lowVsChirpsYears?.length) yield csvRow(['of which far below CHIRPS', c.lowVsChirpsYears.join(' ')]);
	for (const d of c.doubtfulKeepDry ?? []) {
		yield csvRow(['of which a kept-dry run CHIRPS contradicts', d.waterYears.join(' '), `${d.start} to ${d.end}`, d.days, 'CHIRPS on the kept-dry days (mm)', d.chirpsMm, 'limit (mm)', d.limitMm]);
	}
	if (c.flaggedDaysLeftOut) yield csvRow(['Days of flagged zero runs left out (treated as missing)', c.flaggedDaysLeftOut]);
	if (c.missingDaysLeftOut) yield csvRow(['Days listed as missing left out', c.missingDaysLeftOut]);
	if (c.keptDryDaysInFit) yield csvRow(['Kept-dry days kept in the fit', c.keptDryDaysInFit]);
}

/**
 * The double-mass check of catchment rain against CHIRPS (engine ≥ 0.17.0,
 * model.md §2.10a): whole-record slope, the segments between reported
 * breaks, the breaks, then one row per judged water year.
 */
export function* doubleMassLines(dm: NonNullable<RunSummary['dataQuality']>['doubleMass']): Generator<string> {
	yield csvRow(['Double-mass check: catchment rain vs CHIRPS']);
	if (dm === undefined) {
		yield csvRow(['Run made before engine 0.17.0: no double-mass check']);
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
 * The run summary as one CSV sheet of blocks separated by a blank line: run
 * details, the per-farm table, the catchment figures, the CHIRPS bias factors,
 * the catchment rain treated as missing, the double-mass check, calibration, warnings.
 * Fields the engine adds to the summary later still appear (under their key).
 */
export function* summaryCsvLines(meta: SummaryMeta, summary: RunSummary): Generator<string> {
	yield csvRow(['Project', meta.projectName]);
	yield csvRow(['Run', meta.runLabel]);
	yield csvRow(['Run created', meta.createdAt]);
	yield csvRow(['Engine version', meta.engineVersion]);
	yield csvRow(['Period start', meta.startDate]);
	yield csvRow(['Period end', meta.endDate]);
	yield '';

	yield* verificationLines(summary.verification);
	yield '';

	yield csvRow(['Farm summary']);
	const farms = summary.farms as unknown as Record<string, unknown>[];
	const known = new Set(['nodeId', 'name', ...FARM_COLUMNS.map(([k]) => k)]);
	const extra = [...new Set(farms.flatMap((f) => Object.keys(f)))].filter(
		(k) => !known.has(k) && farms.some((f) => scalar(f[k]) !== undefined)
	);
	yield csvRow(['Farm', ...FARM_COLUMNS.map(([, h]) => h), ...extra]);
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
	yield* columnGuideLines();

	if (summary.warnings.length) {
		yield '';
		yield csvRow(['Warnings']);
		for (const w of summary.warnings) yield csvRow([w]);
	}
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

const BALANCE_COLUMNS: [header: string, value: (r: WaterBalanceRow) => number | null][] = [
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
	yield csvRow(['Water year', ...BALANCE_COLUMNS.map(([h]) => h)]);
	for (const r of [...wb.years, wb.total]) {
		const year = r.waterYear === null ? 'Whole run' : `${r.waterYear}/${String((r.waterYear + 1) % 100).padStart(2, '0')}`;
		yield csvRow([year, ...BALANCE_COLUMNS.map(([, f]) => f(r))]);
	}
}

/** What each farm daily column means: its FarmTemplate letter and formula (verify/columns.ts). */
export function* columnGuideLines(): Generator<string> {
	yield csvRow(['Farm daily columns (the daily CSV of a farm)']);
	yield csvRow(['Column', 'Series', 'Formula']);
	for (const c of FARM_DAILY_COLUMNS) yield csvRow([c.letter ?? '', c.key, c.formula]);
}
