import { describe, expect, it } from 'vitest';
import {
	computeFlowColumns,
	computeNaturalFlow,
	excelRound,
	rainToFlow,
	recede,
	recessionIndex,
	seasonFlag,
	type FlowColumns,
	type NaturalFlowInputs
} from './flow';
import { defaultProjectSettings, type CalibrationParams } from './project';

const cal = (over: Partial<CalibrationParams> = {}): CalibrationParams => ({
	...defaultProjectSettings().calibration,
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

describe('excelRound', () => {
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
		expect(recede(c, 1000, 1.5)).toBe(excelRound(1000 * 0.3255));
		expect(recede(c, 32, 79)).toBe(32); // 32 × 0.9845 = 31.504 → 32: the tail floor
	});

	it('recede with a blank (0) index extrapolates below the first factor, as the workbook does', () => {
		// P = -1 → 0.255 − (0.396 − 0.255) = 0.114
		expect(recede(c, 300, 0)).toBe(34);
	});

	it('recessionIndex reads the fractional position off the curve', () => {
		expect(recessionIndex(c, 2553249)).toBe(2);
		expect(recessionIndex(c, 20_000_000)).toBe(1); // above the curve
		expect(recessionIndex(c, 500)).toBe(79); // capped at DaysMax
		const mid = (1011087 + 516665) / 2;
		expect(recessionIndex(c, mid)).toBe(3.5);
	});

	it('rainToFlow = INT(a · rain^b · area·1000 · season factor)', () => {
		expect(rainToFlow(c, 10, false)).toBe(Math.floor(0.09 * 10 ** 1.2 * 205100 * 1));
		expect(rainToFlow(c, 10, true)).toBe(Math.floor(0.09 * 10 ** 1.2 * 205100 * 0.1));
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

describe('computeNaturalFlow', () => {
	it('recedes the initial base flow with no rain', () => {
		const out = computeNaturalFlow(cal(), inputs([0, 0, 0, 0]));
		expect(out.naturalFlowM3Day).toEqual([34, 33, 32, 32]);
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
