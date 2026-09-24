// Pure helpers for the Self-checks panel (SelfChecksPanel.svelte): the
// headline, the water-balance table in Mm³, and the day trace built from
// GET …/runs/:runId/day with the engine's column catalogue (letters and
// formulas), so the UI and the CSV column guide say the same thing.
import { FARM_COLUMNS, GAUGE_COLUMNS, type RunVerification, type WaterBalance, type WaterBalanceRow } from '@water-management/engine';
import type { RunDay } from '$lib/api';

export type Tone = 'ok' | 'bad' | 'none';

export function checksHeadline(v: RunVerification | undefined): { tone: Tone; text: string } {
	if (!v) return { tone: 'none', text: 'This run was made before the model checked itself (engine 0.12.0). Run it again to check it.' };
	const failed = v.checks.filter((c) => !c.passed).length;
	if (failed === 0) return { tone: 'ok', text: `All ${v.checks.length} self-checks passed.` };
	return { tone: 'bad', text: `${failed} of ${v.checks.length} self-checks failed. That is a bug in the model, not in your data: please report it.` };
}

/** "1999/00" for the water year starting October 1999; "Whole run" for the total row. */
export const waterYearLabel = (y: number | null) => (y === null ? 'Whole run' : `${y}/${String((y + 1) % 100).padStart(2, '0')}`);

export interface BalanceColumn {
	key: string;
	label: string;
	title: string;
	value: (r: WaterBalanceRow) => number | null;
}

const MM3 = 1e-6;
/** The water-balance table's columns, volumes in Mm³ (the engine stores m³). */
export const BALANCE_COLUMNS: BalanceColumn[] = [
	{ key: 'rain', label: 'Rain (mm)', title: 'Catchment rain after gap-filling', value: (r) => r.rainMm },
	{ key: 'runoffCoef', label: 'Runoff coeff.', title: 'Natural flow ÷ rain, both as depth over the catchment', value: (r) => r.runoffCoefficient },
	{ key: 'opening', label: 'Start storage', title: 'Σ dam storage at the start (Mm³)', value: (r) => r.openingStorageM3 * MM3 },
	{ key: 'runoff', label: 'Farm runoff', title: 'Σ farm runoff (I), Mm³', value: (r) => r.farmRunoffM3 * MM3 },
	{ key: 'transfers', label: 'Transfers', title: 'Net transfers across all farms; 0 up to float noise (Mm³)', value: (r) => r.transfersM3 * MM3 },
	{ key: 'consumptive', label: 'Consumptive use', title: 'Irrigation supplied − return flow (Mm³)', value: (r) => r.consumptiveUseM3 * MM3 },
	{ key: 'outflow', label: 'Outflow', title: 'Simulated outflow at the outlet (Mm³)', value: (r) => r.outflowM3 * MM3 },
	{ key: 'closing', label: 'End storage', title: 'Σ dam storage at the end (Mm³)', value: (r) => r.closingStorageM3 * MM3 },
	{ key: 'residual', label: 'Residual (m³)', title: 'Start + runoff + transfers − consumptive use − outflow − end; should be 0', value: (r) => r.residualM3 }
];

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
	const catalogue = day.kind === 'gauge' ? GAUGE_COLUMNS : FARM_COLUMNS;
	const byKey = new Map(day.columns.map((c) => [c.key, c]));
	const rows: TraceRow[] = [];
	if (day.kind === 'farm') {
		rows.push({
			key: 'previous_storage',
			letter: 'Q[t−1]',
			label: 'Dam storage at the end of the day before',
			unit: 'm³',
			formula: 'the run’s initial storage (initial % × capacity) on its first day',
			value: day.previousStorageM3
		});
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
	/** H + I + J */
	inflow: number;
	/** G − T */
	consumptive: number;
	/** Q[t] − Q[t−1] */
	storageChange: number;
	/** U */
	outflow: number;
	/** inflow − consumptive − storageChange − outflow: 0 up to float noise. */
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
	const inflow = g('inflow_upstream') + g('runoff') + g('transfer');
	const consumptive = g('supplied') - T;
	const storageChange = g('dam_storage') - day.previousStorageM3;
	const outflow = g('outflow');
	return { inflow, consumptive, storageChange, outflow, residual: inflow - consumptive - storageChange - outflow };
}
