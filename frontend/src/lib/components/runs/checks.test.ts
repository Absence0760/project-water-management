import { FARM_COLUMNS, type RunVerification, type WaterBalanceRow } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { RunDay } from '$lib/api';
import { BALANCE_COLUMNS, balanceTableRows, checksHeadline, dayClosure, residualIsNoise, traceRows, waterYearLabel } from './checks';

const check = (passed: boolean) => ({ id: 'balance' as const, label: 'x', passed, detail: passed ? null : 'broken' });

describe('checksHeadline', () => {
	it('says all passed, how many failed, or that the run predates the checks', () => {
		const v = (p: boolean[]): RunVerification => ({ passed: p.every(Boolean), checks: p.map(check), maxResidual: null });
		expect(checksHeadline(v([true, true, true]))).toEqual({ tone: 'ok', text: 'All 3 self-checks passed.' });
		expect(checksHeadline(v([true, false, false]))).toMatchObject({ tone: 'bad', text: expect.stringMatching(/^2 of 3 self-checks failed/) });
		expect(checksHeadline(undefined)).toMatchObject({ tone: 'none', text: expect.stringMatching(/before .*engine 0\.12\.0/) });
	});
});

const row = (over: Partial<WaterBalanceRow> = {}): WaterBalanceRow => ({
	waterYear: 2000,
	days: 365,
	rainMm: 600,
	naturalFlowMm: 60,
	runoffCoefficient: 0.1,
	runoff: null,
	naturalFlowM3: 2e6,
	farmRunoffM3: 2e6,
	openingStorageM3: 5e5,
	demandM3: 3e5,
	suppliedM3: 2e5,
	returnFlowM3: 2e4,
	consumptiveUseM3: 1.8e5,
	transfersM3: 0,
	spillM3: 1e4,
	outflowM3: 1.82e6,
	closingStorageM3: 5e5,
	residualM3: 0,
	...over
});

describe('water balance table', () => {
	it('labels water years by their two calendar years', () => {
		expect(waterYearLabel(1999)).toBe('1999/00');
		expect(waterYearLabel(2009)).toBe('2009/10');
		expect(waterYearLabel(null)).toBe('Whole run');
	});

	it('shows volumes in Mm³ and the residual in m³', () => {
		const r = row({ residualM3: 3e-7 });
		const val = (k: string) => BALANCE_COLUMNS.find((c) => c.key === k)!.value(r);
		expect(val('runoff')).toBeCloseTo(2, 12);
		expect(val('consumptive')).toBeCloseTo(0.18, 12);
		expect(val('residual')).toBe(3e-7);
	});

	it('lists the years then the whole run', () => {
		const wb = { areaKm2: 10, years: [row({ waterYear: 1999 }), row({ waterYear: 2000 })], total: row({ waterYear: null }) };
		expect(balanceTableRows(wb).map((r) => r.waterYear)).toEqual([1999, 2000, null]);
		expect(balanceTableRows(undefined)).toEqual([]);
	});

	it('treats a residual as noise only when it is tiny next to the volumes moved', () => {
		expect(residualIsNoise(row({ residualM3: 1e-4 }))).toBe(true); // 1e-4 m³ against 2e6 m³
		expect(residualIsNoise(row({ residualM3: 10 }))).toBe(false);
		expect(residualIsNoise(row({ residualM3: -10 }))).toBe(false);
	});
});

// Farm b of the engine's hand-worked day (packages/engine/src/verify/verify.test.ts).
const F = 500 / 31;
const farmDay = (over: Partial<RunDay> = {}): RunDay => ({
	date: '2021-01-01',
	nodeId: 'b',
	name: 'Farm b',
	kind: 'farm',
	previousStorageM3: 500,
	params: { pctUpstreamToDam: 0.4, pctRunoffToDam: 0.5, divertCapacityM3Day: 100, damCapacityM3: 1000, damInitialPct: 0.5, returnFlowPct: 0.1 },
	columns: Object.entries({
		gross_demand: F,
		effective_rain: 0,
		soil_water: 0,
		demand: F,
		supplied: F,
		inflow_upstream: 250,
		runoff: 750,
		transfer: 0,
		upstream_to_dam: 100,
		upstream_below_dam: 150,
		runoff_to_dam: 375,
		runoff_below_dam: 375,
		diverted_to_dam: 100,
		interim_storage: 1075 - F,
		dam_storage: 1000,
		spill: 75 - F,
		below_dam_not_diverted: 425,
		return_flow: F / 10,
		outflow: 500 - (9 * F) / 10,
		balance_residual: 0,
		deficit: 0,
		ewr: 0,
		ewr_cumulative: 0,
		ewr_shortfall: 0,
		ewr_shortfall_incremental: 0
	}).map(([key, value]) => ({ key, label: key, unit: 'm³/day', value })),
	...over
});

describe('day trace', () => {
	it('lists the day-before storage, then every farm column in letter order with its formula', () => {
		const rows = traceRows(farmDay());
		expect(rows[0]).toMatchObject({ key: 'previous_storage', letter: 'Q[t−1]', value: 500 });
		expect(rows.slice(1).map((r) => r.key)).toEqual(FARM_COLUMNS.map((c) => c.key));
		expect(rows.find((r) => r.key === 'supplied')).toMatchObject({ letter: 'G', formula: 'MIN(Q[t−1] + M + O + K + J, F)' });
	});

	it('adds the day-before soil-water store after the storage when the run has one (engine 0.14.0)', () => {
		const rows = traceRows(farmDay({ previousSoilWaterMm: 7.5 }));
		expect(rows.slice(0, 2).map((r) => [r.key, r.value, r.unit])).toEqual([
			['previous_storage', 500, 'm³'],
			['previous_soil_water', 7.5, 'mm']
		]);
		expect(rows.slice(2).map((r) => r.key)).toEqual(FARM_COLUMNS.map((c) => c.key));
		// An older API or run: no row, rather than a made-up 0.
		expect(traceRows(farmDay({ previousSoilWaterMm: null })).map((r) => r.key)).not.toContain('previous_soil_water');
	});

	it('leaves out working columns a pre-0.11 run does not have', () => {
		const old = farmDay();
		old.columns = old.columns.filter((c) => !['upstream_to_dam', 'return_flow', 'balance_residual'].includes(c.key));
		const keys = traceRows(old).map((r) => r.key);
		expect(keys).not.toContain('upstream_to_dam');
		expect(keys).toContain('supplied');
	});

	it('uses the gauge letters for a gauge, with no storage row', () => {
		const gauge = farmDay({
			kind: 'gauge',
			previousStorageM3: null,
			columns: ['inflow_upstream', 'outflow', 'ewr_cumulative', 'ewr_shortfall'].map((key) => ({ key, label: key, unit: 'm³/day', value: 1 }))
		});
		const rows = traceRows(gauge);
		expect(rows.map((r) => [r.key, r.letter])).toEqual([
			['inflow_upstream', 'G'],
			['outflow', null],
			['ewr_cumulative', 'H'],
			['ewr_shortfall', 'I']
		]);
	});

	it('closes the farm balance from the returned numbers', () => {
		const c = dayClosure(farmDay())!;
		expect(c.inflow).toBeCloseTo(1000, 9);
		expect(c.consumptive).toBeCloseTo((9 * F) / 10, 9);
		expect(c.storageChange).toBe(500);
		expect(Math.abs(c.residual)).toBeLessThan(1e-9);
	});

	it('has no closure for a gauge or a run without return flow', () => {
		expect(dayClosure(farmDay({ kind: 'gauge', previousStorageM3: null }))).toBeNull();
		const old = farmDay();
		old.columns = old.columns.filter((c) => c.key !== 'return_flow');
		expect(dayClosure(old)).toBeNull();
	});
});
