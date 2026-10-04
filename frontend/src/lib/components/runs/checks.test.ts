import { FARM_COLUMNS, type RunVerification, type WaterBalanceRow } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { RunCatchmentDay, RunDay } from '$lib/api';
import { BALANCE_COLUMNS, balanceClosure, balanceColumns, balanceEquation, balanceTableRows, checkLabel, catchmentClosure, catchmentTraceRows, checksHeadline, dayClosure, residualIsNoise, traceRows, waterYearLabel } from './checks';

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

	it('says whether each water year closes, naming only the years that don’t', () => {
		const years = Array.from({ length: 30 }, (_, i) => row({ waterYear: 1994 + i }));
		const wb = (ys: WaterBalanceRow[], total = row({ waterYear: null })) => ({ areaKm2: 10, years: ys, total });
		expect(balanceClosure(undefined).tone).toBe('none');
		expect(balanceClosure(wb([]))).toEqual({ tone: 'none', text: 'This run has no water balance by water year (engine 0.12.0). Run it again to check it.' });
		expect(balanceClosure(wb(years))).toEqual({ tone: 'ok', text: 'The water balance closes in all 30 water years and over the whole run: each residual is float noise.' });
		expect(balanceClosure(wb(years.slice(0, 1))).text).toBe('The water balance closes in its one water year and over the whole run: each residual is float noise.');
		// Two years open, and so the whole run: named with their residuals.
		const two = years.map((r, i) => (i === 3 ? { ...r, residualM3: 12.34 } : i === 10 ? { ...r, residualM3: -4 } : r));
		expect(balanceClosure(wb(two, row({ waterYear: null, residualM3: 8.34 })))).toEqual({
			tone: 'bad',
			text: '2 of 30 water years don’t close: 1997/98 (12.3 m³), 2004/05 (-4 m³); nor does the whole run (8.3 m³). Each residual should be float noise: that is a bug in the model, not in your data, so please report it.'
		});
		// A long list is cut after five.
		const many = years.map((r, i) => (i < 8 ? { ...r, residualM3: 100 } : r));
		expect(balanceClosure(wb(many)).text).toMatch(/^8 of 30 water years don’t close: 1994\/95 \(100 m³\), .*1998\/99 \(100 m³\), and 3 more\. /);
		// Every year closes but the total doesn't.
		expect(balanceClosure(wb(years, row({ waterYear: null, residualM3: 50 }))).text).toMatch(/^Every water year closes, but not the whole run \(50 m³\)\. /);
	});

	it('shows a network’s optional terms only when a row has them, so the columns add up to the residual', () => {
		const plain = balanceColumns([row()]).map((c) => c.key);
		expect(plain).toEqual(['rain', 'runoffCoef', 'opening', 'runoff', 'transfers', 'rainOnDams', 'consumptive', 'damEvaporation', 'outflow', 'closing', 'residual']);
		expect(balanceEquation(balanceColumns([row()]))).toBe(
			'Start storage + hydrological unit runoff + transfers + rain on dams = consumptive use + dam evaporation + outflow + end storage'
		);
		// Every term the engine's residual counts (verify.ts): with all of them, each gain and loss is a column.
		const full = row({ groundwaterM3: 3e4, storageSetM3: -1e4, otherUseM3: 5e4, streamDepletionM3: 2e4, damSeepageLostM3: 1e3 });
		const cols = balanceColumns([row(), full]);
		expect(cols.map((c) => c.key)).toEqual([
			'rain', 'runoffCoef', 'opening', 'runoff', 'transfers', 'groundwater', 'storageSet', 'rainOnDams',
			'consumptive', 'damEvaporation', 'otherUse', 'streamDepletion', 'seepageLost', 'outflow', 'closing', 'residual'
		]);
		expect(cols.find((c) => c.key === 'otherUse')!.value(full)).toBeCloseTo(0.05, 12);
		expect(cols.find((c) => c.key === 'storageSet')!.value(full)).toBeCloseTo(-0.01, 12);
		expect(balanceEquation(cols)).toBe(
			'Start storage + hydrological unit runoff + transfers + groundwater + storage set + rain on dams = consumptive use + other users’ use + stream depletion + dam evaporation + seepage lost + outflow + end storage'
		);
	});
});

describe('checkLabel', () => {
	it('says hydrological unit where the engine says farm, keeping capitals and plurals', () => {
		expect(checkLabel('Every farm balances every day')).toBe('Every hydrological unit balances every day');
		expect(checkLabel('Each farm’s soil-water store')).toBe('Each hydrological unit’s soil-water store');
		expect(checkLabel('Farms upstream and farm summaries')).toBe('Hydrological units upstream and hydrological unit summaries');
		expect(checkLabel('Transfers stay within their months')).toBe('Transfers stay within their months');
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
	params: { pctUpstreamToDam: 0.4, pctRunoffToDam: 0.5, divertCapacityM3Day: 100, damCapacityM3: 1000, damInitialPct: 0.5, damMinPct: 0, irrigationEfficiency: 0.9, returnFlowFraction: 0.1, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 },
	columns: Object.entries({
		gross_demand: F,
		effective_rain: 0,
		soil_water: 0,
		crop_requirement: 0.9 * F, // 90 % efficiency: demand = crop requirement ÷ 0.9
		demand: F,
		supplied: F,
		inflow_upstream: 250,
		runoff: 750,
		landcover_reduction: 0,
		transfer: 0,
		upstream_to_dam: 100,
		upstream_below_dam: 150,
		runoff_to_dam: 375,
		runoff_below_dam: 375,
		diverted_to_dam: 100,
		dam_area: 0,
		rain_on_dam: 0,
		dam_evaporation: 0,
		dam_seepage: 0,
		// Present in a run whose dam loses seepage from the catchment or releases water (WP-3.5); none here.
		dam_seepage_lost: 0,
		dam_release: 0,
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
		ewr_shortfall_incremental: 0,
		ewr_charge: 0,
		ewr_charge_irrigation: 0,
		// Present on a farm upstream of two or more EWR sites (engine 1.5.0); an index, 0 = the outlet.
		ewr_binding_site: 0,
		// Present in a run with senior other water users (WP-1.33), boreholes (WP-1.34, WP-3.9), a farm that pumps from the river (WP-3.8) or a storage reset (the review triggers' members, engine 0.46.0); none here.
		senior_requirement: 0,
		passed_for_senior: 0,
		groundwater_used: 0,
		groundwater_to_dam: 0,
		river_abstraction: 0,
		// River off-takes (engine 1.14.0): only on a unit an off-take draws on or reaches.
		offtake_out: 0,
		offtake_in: 0,
		// Canal seepage back to the river (engine 1.42.0): only below an off-take that returns some.
		offtake_loss_return: 0,
		offtake_used: 0,
		offtake_to_dam: 0,
		// Registered volumes (engine 1.18.0): a cap's room per source, a full allocation's demand factor; none here.
		allocation_room_surface: 0,
		allocation_room_groundwater: 0,
		// What is left of the year's volume beside a licence's conditions (engine 1.40.0); none here.
		allocation_left_surface: 0,
		allocation_left_groundwater: 0,
		allocation_demand_factor: 0,
		dam_storage_set: 0,
		depletion_store: 0,
		baseflow_depletion: 0,
		depletion_deficit: 0
	}).map(([key, value]) => ({ key, label: key, unit: 'm³/day', value })),
	...over
});

describe('day trace', () => {
	it('lists the day-before storage, then every farm column in letter order with its formula', () => {
		const rows = traceRows(farmDay());
		expect(rows[0]).toMatchObject({ key: 'previous_storage', letter: 'Q[t−1]', value: 500 });
		expect(rows.slice(1).map((r) => r.key)).toEqual(FARM_COLUMNS.map((c) => c.key));
		expect(rows.find((r) => r.key === 'supplied')).toMatchObject({ letter: 'G', formula: 'MIN(MAX(Q[t−1] + rain on dam − evaporation − seepage + M + O + K + J − release − dam capacity × minimum operating level, 0), D) (release only with a release rule, WP-3.5)' });
	});

	it('shows the land-cover reduction right after the runoff I it was taken from, and only for a farm that has land cover', () => {
		const keys = traceRows(farmDay()).map((r) => r.key);
		expect(keys[keys.indexOf('runoff') + 1]).toBe('landcover_reduction');
		const day = farmDay();
		const without = traceRows({ ...day, columns: day.columns.filter((c) => c.key !== 'landcover_reduction') }).map((r) => r.key);
		expect(without).not.toContain('landcover_reduction');
		expect(without[without.indexOf('runoff') + 1]).toBe('transfer');
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

	it('traces an other water user’s day with its own columns (WP-1.33)', () => {
		const day: RunDay = {
			...farmDay(),
			kind: 'user',
			previousStorageM3: null,
			columns: ['demand', 'inflow_upstream', 'supplied', 'return_flow', 'outflow', 'deficit', 'ewr_cumulative', 'ewr_shortfall', 'ewr_charge'].map((key) => ({ key, label: key, unit: 'm³/day', value: 1 }))
		};
		const rows = traceRows(day);
		expect(rows.map((r) => r.key)).toEqual(['demand', 'inflow_upstream', 'supplied', 'return_flow', 'outflow', 'deficit', 'ewr_cumulative', 'ewr_shortfall', 'ewr_charge']);
		expect(rows.find((r) => r.key === 'outflow')).toMatchObject({ letter: 'U', formula: 'H − G + T' });
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

	it('counts the rain on the dam in and the evaporation out (N2)', () => {
		const day = farmDay();
		day.columns.push({ key: 'rain_on_dam', label: 'rain_on_dam', unit: 'm³/day', value: 30 }, { key: 'dam_evaporation', label: 'dam_evaporation', unit: 'm³/day', value: 30 });
		const c = dayClosure(day)!;
		expect(c.inflow).toBeCloseTo(1030, 9);
		expect(c.evaporation).toBe(30);
		expect(Math.abs(c.residual)).toBeLessThan(1e-9);
	});

	it('has no closure for a gauge or a run without return flow', () => {
		expect(dayClosure(farmDay({ kind: 'gauge', previousStorageM3: null }))).toBeNull();
		const old = farmDay();
		old.columns = old.columns.filter((c) => c.key !== 'return_flow');
		expect(dayClosure(old)).toBeNull();
	});
});

// A GR4J day on 2 km² that closes: 100 mm stored the day before, 12 mm rain,
// −0.5 mm exchange, 3 mm AET, 4 mm flow (8 000 m³/day), 104.5 mm after.
const gr4jDay = (over: Partial<RunCatchmentDay> = {}): RunCatchmentDay => ({
	date: '2021-01-02',
	nodeId: null,
	name: 'Catchment',
	kind: 'catchment',
	runoffModel: 'gr4j',
	areaKm2: 2,
	params: { x1: 350, x2: -1, x3: 90, x4: 1.7, warmupDays: 365 },
	previousStorageMm: 100,
	previousStores: { production_store: 80, routing_store: 15, uh_store: 5 },
	columns: [
		['aet', 3],
		['exchange', -0.5],
		['natural_flow', 8000],
		['pet', 4],
		['production_store', 85],
		['rain_used', 12],
		['rain_chirps', 11],
		['routing_store', 14.5],
		['uh_store', 5]
	].map(([key, value]) => ({ key: key as string, label: key as string, unit: key === 'natural_flow' ? 'm³/day' : 'mm', value: value as number })),
	...over
});

describe('catchmentTraceRows', () => {
	it('lists the GR4J day in model order, each store the day before above it, and the flow as mm', () => {
		const rows = catchmentTraceRows(gr4jDay());
		expect(rows.map((r) => [r.key, r.letter])).toEqual([
			['previous_storage', 'Σ[t−1]'],
			['rain_used', 'P'],
			['pet', 'E'],
			['aet', 'AET'],
			['previous_production_store', 'S[t−1]'],
			['production_store', 'S'],
			['previous_uh_store', 'UH[t−1]'],
			['uh_store', 'UH'],
			['exchange', 'F'],
			['previous_routing_store', 'R[t−1]'],
			['routing_store', 'R'],
			['natural_flow', 'Q'],
			['natural_flow_mm', 'Q (mm)']
		]);
		const v = (k: string) => rows.find((r) => r.key === k)!.value;
		expect(v('previous_production_store')).toBe(80);
		expect(v('natural_flow_mm')).toBe(4);
		// Series outside the catalogue (CHIRPS rain) are not part of the trace.
		expect(rows.some((r) => r.key === 'rain_chirps')).toBe(false);
		expect(rows.find((r) => r.key === 'aet')!.formula).toContain('MIN(P, E)');
	});

	it('shows the exchange as 0 when X2 = 0 left no series, and each store as unknown on the first day of a run from before engine 1.20.0', () => {
		const day = gr4jDay({ previousStores: { production_store: null, routing_store: null, uh_store: null } });
		day.columns = day.columns.filter((c) => c.key !== 'exchange');
		const rows = catchmentTraceRows(day);
		expect(rows.find((r) => r.key === 'exchange')!.value).toBe(0);
		expect(rows.find((r) => r.key === 'previous_routing_store')).toMatchObject({ value: null, formula: expect.stringMatching(/^not recorded: a run from before engine 1\.20\.0/) });
		expect(rows[0]).toMatchObject({ key: 'previous_storage', value: 100 });
	});

	it('starts a run’s first day from each store after the warm-up (engine 1.20.0), and closes on them', () => {
		const day = gr4jDay({ previousStores: { production_store: 80, routing_store: 15, uh_store: 5 } });
		const rows = catchmentTraceRows(day);
		expect(rows.find((r) => r.key === 'previous_uh_store')).toMatchObject({ value: 5, formula: 'the store at the end of the day before (on the run’s first day, after the warm-up)' });
	});

	it('lists the [Flow data] columns of a legacy run, with no stores', () => {
		const day = gr4jDay({ runoffModel: 'legacy', areaKm2: null, params: null, previousStorageMm: null, previousStores: null });
		day.columns = ['base_flow', 'is_summer', 'natural_flow', 'rain_flow', 'rain_used', 'resultant_flow', 'response_flow'].map((key) => ({ key, label: key, unit: null, value: 1 }));
		expect(catchmentTraceRows(day).map((r) => r.letter)).toEqual(['R', 'N', 'V', 'S', 'X', 'Y', 'AB']);
	});
});

describe('catchmentClosure', () => {
	it('closes the day: before + rain + exchange − AET − flow − after', () => {
		const c = catchmentClosure(gr4jDay())!;
		expect(c).toMatchObject({ before: 100, rain: 12, exchange: -0.5, evaporation: 3, flow: 4, after: 104.5 });
		expect(Math.abs(c.residual)).toBeLessThan(1e-12);
	});

	it('shows a residual when the numbers do not close', () => {
		const day = gr4jDay();
		day.columns.find((c) => c.key === 'routing_store')!.value = 16.5;
		expect(catchmentClosure(day)!.residual).toBeCloseTo(-2, 12);
	});

	it('counts a missing exchange as 0, and has no closure for a legacy run or a missing store', () => {
		const day = gr4jDay();
		day.columns = day.columns.filter((c) => c.key !== 'exchange');
		expect(catchmentClosure(day)!.residual).toBeCloseTo(0.5, 12);
		expect(catchmentClosure(gr4jDay({ runoffModel: 'legacy', areaKm2: null, previousStorageMm: null, previousStores: null }))).toBeNull();
		const partial = gr4jDay();
		partial.columns = partial.columns.filter((c) => c.key !== 'uh_store');
		expect(catchmentClosure(partial)).toBeNull();
	});
});
