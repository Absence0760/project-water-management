import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { ModelInput, ModelOutput, NetworkNode, WaterBalanceRow } from '../project';
import { runModel, runModelChecked, runModelWith, withVerification } from '../run';
import { randomInput } from '../testing/fuzz';
import { FARM_COLUMNS } from './columns';
import { verifyRun } from './verify';

const zeros = new Array(12).fill(0) as unknown as Monthly;
const flat = (v: number) => new Array(12).fill(v) as unknown as Monthly;

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Farm ${id}`,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

// Farm u (a quarter of the area, no dam) drains into farm b, which has a dam,
// a diversion, return flow and one crop. Day 1 is worked by hand below.
const handInput = (): ModelInput => ({
	// Natural flow is injected (runModelWith), so no runoff model runs and there is no store balance to check.
	settings: { ewrPragmaticM3PerDay: zeros, apanMm: flat(100) },
	model: {
		nodes: [
			node('u', { areaKm2: 1, downstreamNodeId: 'b' }),
			node('b', {
				areaKm2: 3,
				pctUpstreamToDam: 0.4,
				pctRunoffToDam: 0.5,
				divertCapacityM3Day: 100,
				damCapacityM3: 1000,
				damInitialPct: 0.5,
				irrigationEfficiency: 0.8,
				lossReturnFraction: 0.5
			})
		],
		crops: [{ id: 'c', name: 'Crop', cropFactor: [...flat(0.5)] }],
		cropAreas: [{ nodeId: 'b', cropId: 'c', areaM2: 10_000 }],
		transfers: []
	},
	series: { rain_catchment_mm: { startDate: '2021-01-01', values: [0, 3] } }
});
const handRun = () => withVerification(handInput(), runModelWith(handInput(), () => ({ naturalFlowM3Day: [1000, 1000] })));
const col = (out: ModelOutput, nodeId: string | null, key: string) => out.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;

describe('farm working columns (engine 0.12.0)', () => {
	it('match a day worked by hand', () => {
		const out = handRun();
		const b = (k: string) => col(out, 'b', k)[0]!;
		const F = 500 / 31; // 10 000 m² × 100 mm × 0.5 / 1000 / 31 days
		const D = F / 0.8; // abstraction demand at 80 % efficiency (N1)
		expect(b('gross_demand')).toBeCloseTo(F, 9);
		expect(b('effective_rain')).toBe(0);
		expect(b('soil_water')).toBe(0);
		expect(b('crop_requirement')).toBeCloseTo(F, 9);
		expect(b('demand')).toBeCloseTo(D, 9);
		expect(b('inflow_upstream')).toBeCloseTo(250, 9); // H: farm u's quarter of 1000
		expect(b('runoff')).toBeCloseTo(750, 9); // I
		expect(b('upstream_to_dam')).toBeCloseTo(100, 9); // K = 250 × 0.4
		expect(b('upstream_below_dam')).toBeCloseTo(150, 9); // L
		expect(b('runoff_to_dam')).toBeCloseTo(375, 9); // M = 750 × 0.5
		expect(b('runoff_below_dam')).toBeCloseTo(375, 9); // N
		expect(b('diverted_to_dam')).toBeCloseTo(100, 9); // O = MIN(100, 150 + 375)
		expect(b('supplied')).toBeCloseTo(D, 9); // G: 500 + 375 + 100 + 100 is plenty
		expect(b('interim_storage')).toBeCloseTo(1075 - D, 9); // P
		expect(b('dam_storage')).toBe(1000); // Q
		expect(b('spill')).toBeCloseTo(75 - D, 9); // R
		expect(b('below_dam_not_diverted')).toBeCloseTo(425, 9); // S
		expect(b('return_flow')).toBeCloseTo(D / 10, 9); // T = β (1 − e) G = 0.5 × 0.2 × D
		expect(b('outflow')).toBeCloseTo(500 - (9 * D) / 10, 9); // U = R + S + T
		expect(Math.abs(b('balance_residual'))).toBeLessThan(1e-9); // V
		// Day 2: 3 mm of rain → 10 000 × 0.65 / 1000 × 3 = 19.5 m³ effective, more than the demand F:
		// F is used, and the other 19.5 − F m³ stays in the soil store (N3), 1000 × (19.5 − F) / 10 000 mm.
		expect(col(out, 'b', 'effective_rain')[1]).toBeCloseTo(F, 9);
		expect(col(out, 'b', 'demand')[1]).toBe(0);
		expect(col(out, 'b', 'soil_water')[1]).toBeCloseTo((1000 * (19.5 - F)) / 10_000, 9);
	});

	it('are emitted for farms only, one per catalogue entry', () => {
		const out = handRun();
		// The optional columns come only with the feature that makes them (senior users, WP-1.33): none here.
		const always = FARM_COLUMNS.filter((c) => !c.optional);
		for (const c of always) expect(out.series.some((s) => s.nodeId === 'b' && s.key === c.key), c.key).toBe(true);
		const farmKeys = out.series.filter((s) => s.nodeId === 'b').map((s) => s.key);
		expect(farmKeys.sort()).toEqual(always.map((c) => c.key).sort());
	});
});

describe('verification (engine 0.12.0)', () => {
	it('passes every check on a sound run and reports the largest residual as float noise', () => {
		const out = handRun();
		const v = out.summary.verification!;
		expect(v.checks.map((c) => c.id)).toEqual(['balance', 'workings', 'soilWater', 'runoff', 'transfers', 'reports', 'ewrAttribution', 'groundwater', 'landCover', 'allocations']);
		expect(v.checks.filter((c) => !c.passed)).toEqual([]);
		expect(v.passed).toBe(true);
		expect(v.maxResidual!.valueM3Day).toBeLessThan(1e-9);
		expect(out.summary.warnings.some((w) => w.startsWith('self-check failed'))).toBe(false);
	});

	it('passes on random networks', () => {
		for (const seed of [1, 2, 3]) {
			const v = runModelChecked(randomInput(seed, { maxDays: 400 })).summary.verification!;
			expect(v.checks.filter((c) => !c.passed), `seed ${seed}`).toEqual([]);
		}
	});

	it('is a step after runModel: runModel alone has none, and the series are the same', () => {
		const input = randomInput(7, { maxDays: 200 });
		const plain = runModel(input);
		expect(plain.summary.verification).toBeUndefined();
		const checked = runModelChecked(input);
		expect(checked.summary.verification!.passed).toBe(true);
		expect(checked.series).toEqual(plain.series);
	});

	it('adds each failed check to the warnings', () => {
		const input = handInput();
		const out = handRun();
		const tampered: ModelOutput = structuredClone(out);
		tampered.series.find((s) => s.nodeId === 'b' && s.key === 'dam_storage')!.values[1]! += 10;
		const warned = withVerification(input, tampered).summary.warnings.filter((w) => w.startsWith('self-check failed'));
		expect(warned.length).toBeGreaterThanOrEqual(2);
		expect(warned[0]).toContain('"Farm b" on 2021-01-02');
	});

	it('catches a broken balance and names the farm and the date, not the ids', () => {
		const input = handInput();
		const out = handRun();
		const tampered: ModelOutput = structuredClone(out);
		const storage = tampered.series.find((s) => s.nodeId === 'b' && s.key === 'dam_storage')!;
		storage.values[1] = storage.values[1]! + 10; // 10 m³ appear from nowhere on day 2
		const { verification } = verifyRun(input, tampered);
		expect(verification.passed).toBe(false);
		const balance = verification.checks.find((c) => c.id === 'balance')!;
		expect(balance.passed).toBe(false);
		expect(balance.detail).toContain('"Farm b" on 2021-01-02');
		expect(balance.detail).not.toMatch(/\bday \d/);
		// The working columns no longer add up either; the other checks don't look at storage that way.
		expect(verification.checks.find((c) => c.id === 'workings')!.passed).toBe(false);
	});

	it('catches a soil-water store that overflows or hands out rain that never fell (N3)', () => {
		const input = handInput();
		const out = handRun();
		const check = (o: ModelOutput) => verifyRun(input, o).verification.checks.find((c) => c.id === 'soilWater')!;
		expect(check(out).passed).toBe(true);
		const over: ModelOutput = structuredClone(out);
		over.series.find((s) => s.nodeId === 'b' && s.key === 'soil_water')!.values[1] = 26; // store size 25 mm
		expect(check(over).detail).toContain('"Farm b" on 2021-01-02');
		expect(check(over).detail).toContain('outside 0 … 25 mm');
		// Rain used on the dry first day, and demand lowered to match: the workings still add up, the store doesn't.
		const free: ModelOutput = structuredClone(out);
		free.series.find((s) => s.nodeId === 'b' && s.key === 'effective_rain')!.values[0] = 5;
		free.series.find((s) => s.nodeId === 'b' && s.key === 'demand')!.values[0]! -= 5;
		expect(check(free).passed).toBe(false);
		expect(check(free).detail).toContain('effective rain used 5');
		// A run from before engine 0.14.0 has no store column: nothing to check.
		const old: ModelOutput = structuredClone(out);
		old.series = old.series.filter((s) => s.key !== 'soil_water');
		expect(check(old).passed).toBe(true);
	});

	it('reports a check that cannot run as failed, with the reason', () => {
		const input = handInput();
		const out = handRun();
		const broken: ModelOutput = structuredClone(out);
		delete (broken.summary as { ewrCompliance?: unknown }).ewrCompliance;
		const reports = verifyRun(input, broken).verification.checks.find((c) => c.id === 'reports')!;
		expect(reports.passed).toBe(false);
		expect(reports.detail).toMatch(/^the check could not run: /);
	});
});

describe('water balance per water year (engine 0.12.0)', () => {
	const volumeKeys = ['naturalFlowM3', 'farmRunoffM3', 'demandM3', 'suppliedM3', 'returnFlowM3', 'consumptiveUseM3', 'transfersM3', 'spillM3', 'outflowM3'] as const;
	const scaleOf = (r: WaterBalanceRow) => Math.max(1, r.openingStorageM3, r.farmRunoffM3, r.outflowM3, r.closingStorageM3, r.suppliedM3);

	it('closes every year and adds up to the run', () => {
		for (const seed of [4, 5, 6]) {
			const out = runModelChecked(randomInput(seed));
			const wb = out.summary.waterBalance!;
			const where = `seed ${seed}`;
			expect(wb.years.reduce((s, y) => s + y.days, 0), where).toBe(out.days);
			expect(wb.total.waterYear).toBeNull();
			for (const [i, y] of wb.years.entries()) {
				expect(Math.abs(y.residualM3), `${where} ${y.waterYear}`).toBeLessThan(1e-9 * scaleOf(y));
				expect(y.consumptiveUseM3).toBeCloseTo(y.suppliedM3 - y.returnFlowM3, 6);
				if (i > 0) expect(y.openingStorageM3).toBe(wb.years[i - 1]!.closingStorageM3);
				if (i > 0) expect(y.waterYear).toBe(wb.years[i - 1]!.waterYear! + 1);
				expect(y.runoff, where).not.toBeNull();
				expect(Math.abs(y.runoff!.residualMm)).toBeLessThan(1e-6 * Math.max(1, y.rainMm ?? 0));
			}
			expect(wb.total.openingStorageM3).toBe(wb.years[0]!.openingStorageM3);
			expect(wb.total.closingStorageM3).toBe(wb.years.at(-1)!.closingStorageM3);
			for (const k of volumeKeys) {
				const sum = wb.years.reduce((s, y) => s + y[k], 0);
				expect(Math.abs(wb.total[k] - sum), `${where} ${k}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(sum)));
			}
		}
	});

	it('splits the run at 1 October', () => {
		const input = handInput();
		const days = 400;
		input.series.rain_catchment_mm = { startDate: '2020-09-01', values: new Array(days).fill(1) };
		const out = withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: new Array(days).fill(1000) })));
		const wb = out.summary.waterBalance!;
		// 2020-09-01 … 2020-09-30 is water year 2019; 2020-10-01 … 2021-09-30 is 2020; the rest 2021.
		expect(wb.years.map((y) => [y.waterYear, y.days])).toEqual([
			[2019, 30],
			[2020, 365],
			[2021, 5]
		]);
		expect(wb.total.naturalFlowM3).toBe(400_000);
		expect(wb.areaKm2).toBe(4);
		// 1000 m³/day over 4 km² is 0.25 mm/day against 1 mm of rain.
		expect(wb.total.runoffCoefficient).toBeCloseTo(0.25, 12);
	});
});
