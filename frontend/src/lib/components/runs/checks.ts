// Pure helpers for the Self-checks panel (SelfChecksPanel.svelte): the
// headline, the water-balance table in Mm³, and the day trace built from
// GET …/runs/:runId/day with the engine's column catalogue (letters and
// formulas), so the UI and the CSV column guide say the same thing.
import { FARM_COLUMNS, GAUGE_COLUMNS, GR4J_COLUMNS, LEGACY_RUNOFF_COLUMNS, USER_COLUMNS, type RunVerification, type WaterBalance, type WaterBalanceRow } from '@water-management/engine';
import type { RunCatchmentDay, RunDay } from '$lib/api';

export type Tone = 'ok' | 'bad' | 'none';

export function checksHeadline(v: RunVerification | undefined): { tone: Tone; text: string } {
	if (!v) return { tone: 'none', text: 'This run was made before the model checked itself (engine 0.12.0). Run it again to check it.' };
	const failed = v.checks.filter((c) => !c.passed).length;
	if (failed === 0) return { tone: 'ok', text: `All ${v.checks.length} self-checks passed.` };
	return { tone: 'bad', text: `${failed} of ${v.checks.length} self-checks failed. That is a bug in the model, not in your data: please report it.` };
}

/**
 * A check's words as the modeller workspace says them: the engine writes
 * "farm" (the CSV's and the API's word), the workspace says "hydrological unit" (#54; #90 Q6).
 */
export const checkLabel = (label: string) =>
	label.replace(/\b([Ff])arm(s?)\b/g, (_, f: string, s: string) => `${f === 'F' ? 'H' : 'h'}ydrological unit${s}`);

/** "1999/00" for the water year starting October 1999; "Whole run" for the total row. */
export const waterYearLabel = (y: number | null) => (y === null ? 'Whole run' : `${y}/${String((y + 1) % 100).padStart(2, '0')}`);

export interface BalanceColumn {
	key: string;
	label: string;
	title: string;
	value: (r: WaterBalanceRow) => number | null;
	/** A term only some networks have: shown only when a row has it (as in the summary CSV). */
	optional?: true;
}

const MM3 = 1e-6;
const opt = (m3: number | undefined) => (m3 === undefined ? null : m3 * MM3);
/** The water-balance table's columns, volumes in Mm³ (the engine stores m³). */
export const BALANCE_COLUMNS: BalanceColumn[] = [
	{ key: 'rain', label: 'Rain (mm)', title: 'Catchment rain after gap-filling', value: (r) => r.rainMm },
	{ key: 'runoffCoef', label: 'Runoff coeff.', title: 'Natural flow ÷ rain, both as depth over the catchment', value: (r) => r.runoffCoefficient },
	{ key: 'opening', label: 'Start storage', title: 'Σ dam storage at the start (Mm³)', value: (r) => r.openingStorageM3 * MM3 },
	{ key: 'runoff', label: 'Hydrological unit runoff', title: 'Σ hydrological unit runoff (I), Mm³', value: (r) => r.farmRunoffM3 * MM3 },
	{ key: 'transfers', label: 'Transfers', title: 'Net transfers across all hydrological units; 0 up to float noise (Mm³)', value: (r) => r.transfersM3 * MM3 },
	{ key: 'groundwater', label: 'Groundwater pumped', title: 'Groundwater pumped into supply and the dams, a gain to the river network (Mm³)', value: (r) => opt(r.groundwaterM3), optional: true },
	{ key: 'storageSet', label: 'Storage set', title: 'Storage set into (+) or out of (−) the dams by a storage reset (Mm³)', value: (r) => opt(r.storageSetM3), optional: true },
	{ key: 'rainOnDams', label: 'Rain on dams', title: 'Rain falling on the dams’ surface (Mm³); blank for runs before engine 0.16.0', value: (r) => (r.rainOnDamsM3 === undefined ? null : r.rainOnDamsM3 * MM3) },
	{ key: 'consumptive', label: 'Consumptive use', title: 'Irrigation supplied − return flow (Mm³)', value: (r) => r.consumptiveUseM3 * MM3 },
	{ key: 'damEvaporation', label: 'Dam evaporation', title: 'Open-water evaporation from the dams (Mm³); seepage is part of the outflow. Blank for runs before engine 0.16.0', value: (r) => (r.damEvaporationM3 === undefined ? null : r.damEvaporationM3 * MM3) },
	{ key: 'otherUse', label: 'Other users’ use', title: 'Other water users: taken − returned (Mm³)', value: (r) => opt(r.otherUseM3), optional: true },
	{ key: 'streamDepletion', label: 'Stream depletion', title: 'Taken from the river by borehole pumping (Mm³)', value: (r) => opt(r.streamDepletionM3), optional: true },
	{ key: 'seepageLost', label: 'Seepage lost', title: 'Dam seepage lost from the catchment rather than returned below the dam (Mm³)', value: (r) => opt(r.damSeepageLostM3), optional: true },
	{ key: 'conveyanceLoss', label: 'Off-take losses', title: 'River off-takes: taken − delivered, lost from the catchment on the way (Mm³)', value: (r) => opt(r.conveyanceLossM3), optional: true },
	{ key: 'outflow', label: 'Outflow', title: 'Simulated outflow at the outlet (Mm³)', value: (r) => r.outflowM3 * MM3 },
	{ key: 'closing', label: 'End storage', title: 'Σ dam storage at the end (Mm³)', value: (r) => r.closingStorageM3 * MM3 },
	{ key: 'residual', label: 'Residual (m³)', title: 'The equation’s left side − its right side (every gain − every loss − the change in storage); should be 0', value: (r) => r.residualM3 }
];

/** The columns a run's rows have: every always-there column, and an optional one only when some row has it. */
export const balanceColumns = (rows: readonly WaterBalanceRow[]): BalanceColumn[] =>
	BALANCE_COLUMNS.filter((c) => !c.optional || rows.some((r) => c.value(r) !== null));

/** The equation the table closes, naming only the columns shown (so each term in it is a column). */
export function balanceEquation(cols: readonly BalanceColumn[]): string {
	const has = (k: string) => cols.some((c) => c.key === k);
	const plus = (k: string, w: string) => (has(k) ? ` + ${w}` : '');
	return (
		`Start storage + hydrological unit runoff + transfers${plus('groundwater', 'groundwater')}${plus('storageSet', 'storage set')} + rain on dams = ` +
		`consumptive use${plus('otherUse', 'other users’ use')}${plus('streamDepletion', 'stream depletion')} + dam evaporation${plus('seepageLost', 'seepage lost')} + outflow + end storage`
	);
}

/** Years then the whole run, or nothing for a run without a water balance. */
export const balanceTableRows = (wb: WaterBalance | undefined): WaterBalanceRow[] => (wb ? [...wb.years, wb.total] : []);

/**
 * A residual is float noise when it is below 1e-9 of the volumes the row
 * moves (1 m³ in a catchment moving 10⁹ m³ is noise; 1 m³ in 1 000 m³ is not).
 */
export function residualIsNoise(r: WaterBalanceRow): boolean {
	const scale = Math.max(1, r.openingStorageM3, r.farmRunoffM3, r.outflowM3, r.closingStorageM3, r.suppliedM3);
	return Math.abs(r.residualM3) <= 1e-9 * scale;
}

export interface TraceRow {
	key: string;
	letter: string | null;
	label: string;
	unit: string | null;
	formula: string;
	value: number | null;
}

/** The day's columns in FarmTemplate (or GaugeTemplate) order, with the storage the day started from. */
export function traceRows(day: RunDay): TraceRow[] {
	const catalogue = day.kind === 'gauge' ? GAUGE_COLUMNS : day.kind === 'user' ? USER_COLUMNS : FARM_COLUMNS;
	const byKey = new Map(day.columns.map((c) => [c.key, c]));
	const rows: TraceRow[] = [];
	if (day.kind === 'farm') {
		rows.push({
			key: 'previous_storage',
			letter: 'Q[t−1]',
			label: 'Dam storage at the end of the day before',
			unit: 'm³',
			formula: 'the run’s initial storage on its first day (initial % × that day’s capacity)',
			value: day.previousStorageM3
		});
		// The store the day's effective rain was added to (engine ≥ 0.14.0).
		if (day.previousSoilWaterMm != null) {
			rows.push({
				key: 'previous_soil_water',
				letter: 'soil[t−1]',
				label: 'Soil-water store at the end of the day before',
				unit: 'mm',
				formula: 'empty (0) on the run’s first day',
				value: day.previousSoilWaterMm
			});
		}
	}
	for (const c of catalogue) {
		const col = byKey.get(c.key);
		// A run from before engine 0.12.0 has no working columns: leave them out.
		if (!col) continue;
		rows.push({ key: c.key, letter: c.letter, label: col.label, unit: col.unit, formula: c.formula, value: col.value });
	}
	return rows;
}

export interface Closure {
	/** H + I + J + rain on the dam (engine ≥ 0.16.0) */
	inflow: number;
	/** G − T */
	consumptive: number;
	/** Evaporation from the dam (engine ≥ 0.16.0; 0 for older runs). */
	evaporation: number;
	/** Q[t] − Q[t−1] */
	storageChange: number;
	/** U */
	outflow: number;
	/** inflow − consumptive − evaporation − storageChange − outflow: 0 up to float noise. */
	residual: number;
}

/** The farm's balance that day, worked from the returned numbers alone; null for a gauge or a run missing a column. */
export function dayClosure(day: RunDay): Closure | null {
	if (day.kind !== 'farm' || day.previousStorageM3 === null) return null;
	const v = new Map(day.columns.map((c) => [c.key, c.value]));
	const need = ['inflow_upstream', 'runoff', 'transfer', 'supplied', 'dam_storage', 'outflow'];
	if (need.some((k) => typeof v.get(k) !== 'number')) return null;
	const g = (k: string) => v.get(k) as number;
	// Return flow is a working column (engine ≥ 0.12.0); an older run has none.
	const T = v.get('return_flow');
	if (typeof T !== 'number') return null;
	// Rain on the dam and evaporation from it (audit N2); a run before engine 0.16.0 has neither. Seepage is in U.
	const num = (k: string) => {
		const x = v.get(k);
		return typeof x === 'number' ? x : 0;
	};
	const inflow = g('inflow_upstream') + g('runoff') + g('transfer') + num('rain_on_dam');
	const consumptive = g('supplied') - T;
	const evaporation = num('dam_evaporation');
	const storageChange = g('dam_storage') - day.previousStorageM3;
	const outflow = g('outflow');
	return { inflow, consumptive, evaporation, storageChange, outflow, residual: inflow - consumptive - evaporation - storageChange - outflow };
}

/** The runoff model's stores (run_series keys) with their symbols, in GR4J_COLUMNS order. */
const RUNOFF_STORES: Record<string, string> = { production_store: 'S', uh_store: 'UH', routing_store: 'R' };

/**
 * The catchment's day (the runoff model's trace) in the order the model
 * computes it: each store's content the day before just above its end-of-day
 * row, and the natural flow also as mm over the catchment, so the store
 * balance can be read off the table. A legacy run lists its [Flow data]
 * columns; a model without a catalogue lists what the run stored.
 */
export function catchmentTraceRows(day: RunCatchmentDay): TraceRow[] {
	const byKey = new Map(day.columns.map((c) => [c.key, c]));
	const catalogue = day.runoffModel === 'gr4j' ? GR4J_COLUMNS : day.runoffModel === 'legacy' ? LEGACY_RUNOFF_COLUMNS : null;
	if (!catalogue) return day.columns.map((c) => ({ key: c.key, letter: null, label: c.label, unit: c.unit, formula: '', value: c.value }));
	const rows: TraceRow[] = [];
	if (day.previousStorageMm !== null) {
		rows.push({
			key: 'previous_storage',
			letter: 'Σ[t−1]',
			label: 'All stores at the end of the day before',
			unit: 'mm',
			formula: 'S[t−1] + R[t−1] + UH[t−1]; on the run’s first day, the storage after the warm-up',
			value: day.previousStorageMm
		});
	}
	for (const c of catalogue) {
		const col = byKey.get(c.key);
		const store = day.previousStores ? RUNOFF_STORES[c.key] : undefined;
		if (store && col) {
			const value = day.previousStores![c.key] ?? null;
			rows.push({
				key: `previous_${c.key}`,
				letter: `${store}[t−1]`,
				label: `${col.label}, the day before`,
				unit: 'mm',
				// Null only on the first day of a run from before engine 1.20.0, which kept only the stores' total there.
				formula:
					value === null
						? 'not recorded: a run from before engine 1.20.0 kept only the stores’ total on its first day'
						: 'the store at the end of the day before (on the run’s first day, after the warm-up)',
				value
			});
		}
		if (!col) {
			// GR4J stores no exchange series when X2 = 0: the catchment is closed and the exchange is 0.
			if (c.key === 'exchange' && day.runoffModel === 'gr4j')
				rows.push({ key: c.key, letter: c.letter, label: 'Groundwater exchange (+ gained / − lost)', unit: 'mm', formula: c.formula, value: 0 });
			continue;
		}
		rows.push({ key: c.key, letter: c.letter, label: col.label, unit: col.unit, formula: c.formula, value: col.value });
	}
	const q = byKey.get('natural_flow')?.value;
	if (day.areaKm2 && typeof q === 'number') {
		rows.push({
			key: 'natural_flow_mm',
			letter: 'Q (mm)',
			label: 'Natural flow as depth over the catchment',
			unit: 'mm',
			formula: `Q ÷ (${day.areaKm2} km² × 1000)`,
			value: q / (day.areaKm2 * 1000)
		});
	}
	return rows;
}

export interface StoreClosure {
	/** Σ stores at the end of the day before (mm). */
	before: number;
	/** P */
	rain: number;
	/** F (+ gained, − lost); 0 when the run stored none (X2 = 0). */
	exchange: number;
	/** AET */
	evaporation: number;
	/** Q in mm over the catchment. */
	flow: number;
	/** Σ stores at the end of the day (mm). */
	after: number;
	/** before + rain + exchange − evaporation − flow − after: 0 up to float noise. */
	residual: number;
}

/** The runoff model's store balance that day, from the returned numbers alone; null for a legacy run or a missing column. */
export function catchmentClosure(day: RunCatchmentDay): StoreClosure | null {
	if (day.previousStorageMm === null || !day.areaKm2) return null;
	const v = new Map(day.columns.map((c) => [c.key, c.value]));
	const need = ['rain_used', 'aet', 'natural_flow', ...Object.keys(RUNOFF_STORES)];
	if (need.some((k) => typeof v.get(k) !== 'number')) return null;
	const g = (k: string) => v.get(k) as number;
	const ex = v.get('exchange');
	const before = day.previousStorageMm;
	const rain = g('rain_used');
	const exchange = typeof ex === 'number' ? ex : 0;
	const evaporation = g('aet');
	const flow = g('natural_flow') / (day.areaKm2 * 1000);
	const after = Object.keys(RUNOFF_STORES).reduce((s, k) => s + g(k), 0);
	return { before, rain, exchange, evaporation, flow, after, residual: before + rain + exchange - evaporation - flow - after };
}
