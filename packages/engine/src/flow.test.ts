import { describe, expect, it } from 'vitest';
import {
	computeFlowColumns,
	computeNaturalFlow,
	rainToFlow,
	recede,
	recessionIndex,
	seasonFlag,
	type FlowColumns,
	type NaturalFlowInputs
} from './flow';
import { defaultProjectSettings, type CalibrationParams } from './project';
import { excelRound } from './network/round';

const cal = (over: Partial<CalibrationParams> = {}): CalibrationParams => ({
	...defaultProjectSettings().calibration,
	// Fixture area (the blank workbook's farm total); the real default is null = summed farm areas.
	catchmentAreaKm2: 205.1,
	...over
});

const inputs = (rain: (number | null)[], startDate = '2021-01-01'): NaturalFlowInputs => ({
	startDate,
	days: rain.length,
	rainCatchmentMm: rain,
	rainChirpsMm: rain.map(() => null),
	rainForecastMm: rain.map(() => null),
	flowPitmanM3s: rain.map(() => null)
});

describe('excelRound (test helper for replaying workbook cells)', () => {
	it('rounds half away from zero on the decimal value', () => {
		expect(excelRound(2.5)).toBe(3);
		expect(excelRound(-2.5)).toBe(-3);
		expect(excelRound(1.005, 2)).toBe(1.01);
		expect(excelRound(2.675, 2)).toBe(2.68);
		expect(excelRound(79.12345, 4)).toBe(79.1235);
		expect(excelRound(1e-20, 4)).toBe(0);
	});
});

describe('recession helpers', () => {
	const c = cal();
	it('recede interpolates between table factors', () => {
		// index 1.5 → halfway between 0.255 and 0.396
		expect(recede(c, 1000, 1.5)).toBeCloseTo(1000 * 0.3255, 9);
		expect(recede(c, 32, 79)).toBeCloseTo(31.504, 9); // the workbook's ROUND kept it at 32 for ever
	});

	it('recede below index 1 extrapolates below the first factor (pulse indices start at shiftPeakIndexLo = 0.9)', () => {
		// P = -0.1 → 0.255 − 0.1 × (0.396 − 0.255) = 0.2409
		expect(recede(c, 1000, 0.9)).toBeCloseTo(240.9, 0);
	});

	it('recessionIndex reads the fractional position off the curve', () => {
		expect(recessionIndex(c, 2553249)).toBe(2);
		expect(recessionIndex(c, 20_000_000)).toBe(1); // above the curve
		expect(recessionIndex(c, 500)).toBe(79); // capped at DaysMax
		const mid = (1011087 + 516665) / 2;
		expect(recessionIndex(c, mid)).toBe(3.5);
	});

	it('rainToFlow = a · rain^b · area·1000 · season factor (the workbook takes INT)', () => {
		expect(rainToFlow(c, 10, false)).toBeCloseTo(0.09 * 10 ** 1.2 * 205100 * 1, 9);
		expect(rainToFlow(c, 10, true)).toBeCloseTo(0.09 * 10 ** 1.2 * 205100 * 0.1, 9);
		expect(rainToFlow(c, 0, false)).toBe(0);
	});
});

describe('seasonFlag', () => {
	const c = cal();
	it('summer months are always summer', () => {
		expect(seasonFlag(c, 1, 0, 100, 100)).toBe(1);
	});
	it('winter persists once reached', () => {
		expect(seasonFlag(c, 7, 0, 0, 0)).toBe(0);
	});
	it('leaving summer needs heavy rain today or moderate rain yesterday', () => {
		expect(seasonFlag(c, 6, 1, 0, 0)).toBe(1);
		expect(seasonFlag(c, 6, 1, 35, 0)).toBe(0);
		expect(seasonFlag(c, 6, 1, 0, 9)).toBe(0);
		expect(seasonFlag(c, 6, 1, 34.9, 8.9)).toBe(1);
	});
});

describe('day-1 state (audit E1)', () => {
	it('recedes the initial base flow at its own recession index, not at a blank index 0', () => {
		// The workbook's reserved row leaves the base index blank (0), so day 1
		// recedes at the extrapolated factor 2·f1 − f2 (0.114): 300 → 34, an 89 %
		// drop on the first day of every run. A steady base flow recedes at the
		// factor for its own position on the curve (index 79 → 0.9845).
		const c = computeFlowColumns(cal(), inputs([0, 0, 0]));
		expect(c.baseFlow[0]).toBeCloseTo(300 * 0.9845, 9);
		expect(c.baseIndex[0]).toBe(79);
		expect(c.naturalFlowM3Day[0]).toBeCloseTo(300 * 0.9845, 9);
	});

	it('never turns the base flow negative, whatever the first two recession factors', () => {
		// f2 > 2·f1 made the day-1 factor negative: base flow −30 m³/day, and a
		// negative base can never reset (rain / negative base is never > 1.5).
		const factors = [...cal().recessionFactors];
		factors[0] = 0.1;
		factors[1] = 0.3;
		const c = computeFlowColumns(cal({ recessionFactors: factors }), inputs([0, 0, 50, 0, 0], '2021-07-01'));
		expect(c.baseFlow.every((v) => v >= 0)).toBe(true);
		expect(c.baseFlow[2]).toBe(c.rainFlow[2]); // the storm resets it
	});
});

describe('no rounding in the model state (audit R1)', () => {
	it('keeps receding through a long dry spell instead of sticking at a rounding floor', () => {
		// With ROUND(flow × f, 0) a flow stops receding once flow × (1 − f) < 0.5:
		// 32 m³/day for the default tail factor 0.9845, however long the drought.
		const c = computeFlowColumns(cal(), inputs(new Array(400).fill(0), '2021-07-01'));
		expect(c.baseFlow[399]).toBeCloseTo(300 * 0.9845 ** 400, 6);
		expect(c.baseFlow[399]).toBeLessThan(1);
	});

	it('rain-added flow is a·R^b·area·factor, not floored to whole m³', () => {
		expect(rainToFlow(cal(), 3, true)).toBeCloseTo(0.09 * 3 ** 1.2 * 205_100 * 0.1, 9);
	});
});

describe('recede (audit E2)', () => {
	it('clamps an extrapolated factor at 0: flow never recedes below zero', () => {
		// A pulse index below 1 (shiftPeakIndexLo < 1) extrapolates below the
		// first factor; with index 0 and f2 > 2·f1 that is negative.
		const factors = [...cal().recessionFactors];
		factors[0] = 0.1;
		factors[1] = 0.3;
		expect(recede(cal({ recessionFactors: factors }), 1000, 0)).toBe(0);
		// Inside the table nothing changes.
		expect(recede(cal(), 1000, 1.5)).toBeCloseTo(1000 * 0.3255, 9);
	});
});

describe('computeNaturalFlow', () => {
	it('recedes the initial base flow with no rain', () => {
		const out = computeNaturalFlow(cal(), inputs([0, 0, 0, 0]));
		const f = 0.9845; // factor at index 79, where 300 m³/day sits on the default curve
		out.naturalFlowM3Day.forEach((v, i) => expect(v).toBeCloseTo(300 * f ** (i + 1), 9));
		expect(out.series.map((s) => s.key)).toEqual([
			'rain_used',
			'is_summer',
			'rain_flow',
			'base_flow',
			'response_flow',
			'resultant_flow'
		]);
	});

	it('ignores rain at or below the threshold', () => {
		const out = computeNaturalFlow(cal(), inputs([2, 0]));
		expect(out.series[0]!.values).toEqual([0, 0]);
		expect(out.series[2]!.values).toEqual([0, 0]);
	});

	it('uses the first present rain source: catchment, then CHIRPS, then forecast', () => {
		const c = computeFlowColumns(cal(), {
			...inputs([null, 0, null]),
			rainChirpsMm: [5, 50, null],
			rainForecastMm: [7, 7, 3]
		});
		expect(c.rainUsedMm).toEqual([5, 0, 3]);
	});

	it('a winter storm resets the base flow and adds a receding response', () => {
		const c = computeFlowColumns(cal(), inputs([0, 40, 0, 0], '2021-07-01'));
		expect(c.isSummer).toEqual([0, 0, 0, 0]);
		const peak = rainToFlow(cal(), 40, false);
		expect(c.rainFlow[1]).toBe(peak);
		expect(c.baseFlow[1]).toBe(peak); // rain/base ratio far above 1.5
		expect(c.naturalFlowM3Day[1]).toBeGreaterThanOrEqual(peak);
		expect(c.naturalFlowM3Day[2]).toBeLessThan(c.naturalFlowM3Day[1]!);
		expect(c.naturalFlowM3Day[3]).toBeLessThan(c.naturalFlowM3Day[2]!);
	});

	it('falls back to Pitman flow (m³/s → m³/day) when the rain model gives 0', () => {
		const c = computeFlowColumns(cal({ baseFlowInitial: 0 }), {
			...inputs([0]),
			flowPitmanM3s: [0.5]
		});
		expect(c.resultantFlow[0]).toBe(0);
		expect(c.naturalFlowM3Day[0]).toBe(43200);
	});
});

// ---------------------------------------------------------------------------
// Regression against a real workbook's computed [Flow data] columns. The
// fixture is client data (gitignored); regenerate it with
//   python scripts/wbt-import/extract_flow_fixture.py "<workbook>.xlsm" data/fixtures/client-catchment-flow.json
// ---------------------------------------------------------------------------

interface Fixture {
	source: string;
	startDate: string;
	days: number;
	calibration: CalibrationParams;
	inputs: Omit<NaturalFlowInputs, 'startDate' | 'days'>;
	expected: Record<keyof FlowColumns, number[]>;
}

const FIXTURE_REL = 'data/fixtures/client-catchment-flow.json';

async function loadFixture(): Promise<Fixture | null> {
	// No @types/node in this package (it must stay browser-safe), so reach
	// node's fs/url through untyped dynamic imports; tests only run under node.
	const fsMod = 'node:fs';
	const urlMod = 'node:url';
	const fs = await import(/* @vite-ignore */ fsMod);
	const { fileURLToPath } = await import(/* @vite-ignore */ urlMod);
	const path = fileURLToPath(new (globalThis as any).URL(`../../../${FIXTURE_REL}`, import.meta.url));
	if (!fs.existsSync(path)) return null;
	return JSON.parse(fs.readFileSync(path, 'utf8')) as Fixture;
}

const fixture = await loadFixture();
if (!fixture) {
	console.warn(`[flow.test] ${FIXTURE_REL} not found — skipping the workbook regression (client data is not in CI).`);
}

const COMPARED: (keyof FlowColumns)[] = [
	'isSummer',
	'rainUsedMm',
	'baseFlow',
	'baseIndex',
	'responseStart',
	'rainFlow',
	'addedIndex',
	'responseAdded',
	'resultantFlow',
	'resultantIndex',
	'naturalFlowM3Day'
];

describe.skipIf(!fixture)(`workbook regression (${FIXTURE_REL})`, () => {
	it('matches every [Flow data] column day by day', () => {
		const f = fixture!;
		const got = computeFlowColumns(f.calibration, { startDate: f.startDate, days: f.days, ...f.inputs });
		// Guard against a vacuous pass: the series must contain real rain events
		// in both seasons and base-flow resets.
		expect(f.expected.rainFlow.filter((v) => v > 0).length).toBeGreaterThan(100);
		expect(new Set(f.expected.isSummer)).toEqual(new Set([0, 1]));

		const mismatches: string[] = [];
		for (const key of COMPARED) {
			const exp = f.expected[key];
			let count = 0;
			let first = -1;
			for (let i = 0; i < f.days; i++) {
				if (got[key][i] !== exp[i]) {
					count++;
					if (first < 0) first = i;
				}
			}
			if (count > 0) {
				mismatches.push(`${key}: ${count}/${f.days} days differ, first [${first}] got ${got[key][first]} want ${exp[first]}`);
			}
		}
		expect(mismatches).toEqual([]);
	});
});
