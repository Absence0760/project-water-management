// Pure builders for a run's CSV exports: column order for the daily table and
// the multi-block summary sheet. Unit-tested in run-tables.test.ts.
import type { RunSummary } from '@water-management/engine';
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
	'is_summer',
	'rain_flow',
	'base_flow',
	'response_flow',
	'resultant_flow'
];
const NODE_ORDER = [
	'demand',
	'supplied',
	'deficit',
	'inflow_upstream',
	'runoff',
	'transfer',
	'dam_storage',
	'spill',
	'outflow',
	'ewr',
	'ewr_cumulative',
	'ewr_shortfall',
	'ewr_shortfall_incremental'
];
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
	['avgDemandM3Day', 'Average demand (m³/day)'],
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

/**
 * The run summary as one CSV sheet of blocks separated by a blank line: run
 * details, the per-farm table, the catchment figures, calibration, warnings.
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

	yield csvRow(['Calibration (outflow gauge vs observed)']);
	if (summary.calibration) {
		for (const row of labelledRows(summary.calibration as unknown as Record<string, unknown>, CALIBRATION_ROWS)) {
			yield csvRow(row);
		}
	} else {
		yield csvRow(['No observed flow series — calibration not computed']);
	}

	if (summary.warnings.length) {
		yield '';
		yield csvRow(['Warnings']);
		for (const w of summary.warnings) yield csvRow([w]);
	}
}
