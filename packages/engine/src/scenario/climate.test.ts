// The climate.delta op and its factors (issue #621, docs/model.md §2.17).
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import {
	annualRainFactor,
	applyClimateDelta,
	climateDeltaFactors,
	extraterrestrialRadiationMm,
	hargreavesSamaniMm,
	windowClimate,
	type ClimateCell,
	type ClimateDeltaOp,
	type MonthlyClimate
} from './climate';
import { scenarioConflicts } from './combine';
import { validateScenarioOps, type ScenarioOp } from './ops';
import { applyScenario, classifyOp } from './overrides';

const ones = () => new Array<number>(12).fill(1);
const delta = (rain: number[], evap: number[] = ones()): ClimateDeltaOp => ({ op: 'climate.delta', rainFactorByMonth: rain, evapFactorByMonth: evap, label: 'SYN-A SSP2-4.5 2036–2065', source: 'synthetic factors (test)' });
const flat = (pr: number, tx: number, tn: number): MonthlyClimate => ({ prMm: new Array(12).fill(pr), tasmaxC: new Array(12).fill(tx), tasminC: new Array(12).fill(tn) });

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** A base with rain on 2020-01-30 … 2020-02-02 (two January days, two February days), a daily A-pan, a unit's own rain and a station. */
function base(): ModelInput {
	const apan = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210] as unknown as Monthly;
	return {
		settings: { apanMm: apan, pe: { kind: 'monthly', mm: apan, source: 'test' }, unitRain: { mode: 'perUnit', gaugeMapMm: 600, gaugeMapSource: 'test' } as never, rainStations: { catchmentMapMm: 500 } as never },
		model: { nodes: [node('u', { downstreamNodeId: 'g', mapMm: 700, mapSource: 'test' } as Partial<NetworkNode>), node('g', { kind: 'gauge', areaKm2: 0 })], crops: [], cropAreas: [], transfers: [] },
		series: {
			rain_catchment_mm: { startDate: '2020-01-30', values: [10, null, 4, -9] },
			rain_chirps_mm: { startDate: '2020-01-30', values: [8, 2, 3, 1] },
			'rain_chirps_mm@u': { startDate: '2020-01-31', values: [5, 5] },
			'rain_station_mm#s1': { startDate: '2020-01-30', values: [1, 1, 1, 1] },
			evap_apan_mm: { startDate: '2020-01-31', values: [6, 6] },
			flow_observed_m3s: { startDate: '2020-01-30', values: [1, 1, 1, 1] }
		},
		stations: { s1: { name: 'S1', mapMm: 400, mapSource: 'test', lat: null, lon: null } }
	};
}

describe('climate.delta factors', () => {
	it("FAO-56's worked extraterrestrial radiation: 20° S on 3 September is 32.2 MJ m⁻² day⁻¹ (13.1 mm/day)", () => {
		expect(extraterrestrialRadiationMm(-20, 246) / 0.408).toBeCloseTo(32.2, 1);
		// The polar night gives none, not a negative.
		expect(extraterrestrialRadiationMm(-80, 172)).toBeGreaterThanOrEqual(0);
	});

	it('Hargreaves–Samani is 0.0023 Ra (Tmean + 17.8) √(Tmax − Tmin), and 0 without a range', () => {
		expect(hargreavesSamaniMm(30, 14, 15)).toBeCloseTo(0.0023 * 15 * (22 + 17.8) * 4, 12);
		expect(hargreavesSamaniMm(10, 10, 15)).toBe(0);
		expect(hargreavesSamaniMm(10, 12, 15)).toBe(0);
	});

	it('rain is the ratio of the area-weighted means, not the mean of the ratios', () => {
		const cells: ClimateCell[] = [
			{ lat: -33.9, weight: 3, baseline: flat(100, 25, 10), future: flat(80, 26, 11) },
			{ lat: -34.1, weight: 1, baseline: flat(20, 25, 10), future: flat(40, 26, 11) },
			{ lat: -34.3, weight: 0, baseline: flat(1, 25, 10), future: flat(1000, 26, 11) }
		];
		const f = climateDeltaFactors(cells);
		// (3·80 + 40) ÷ (3·100 + 20) = 280 ÷ 320; the weightless cell counts for nothing.
		for (const v of f.rainFactorByMonth) expect(v).toBeCloseTo(280 / 320, 12);
		expect(f.warnings).toEqual([]);
		// Hotter by a degree, the same range: PET up by (18.5 + 17.8) ÷ (17.5 + 17.8) in every month.
		for (const v of f.evapFactorByMonth) expect(v).toBeCloseTo(36.3 / 35.3, 3);
	});

	it('the same climate in both windows gives factors of exactly 1', () => {
		const c = { prMm: [90, 80, 70, 40, 20, 10, 5, 8, 15, 40, 60, 85], tasmaxC: new Array(12).fill(24), tasminC: new Array(12).fill(9) };
		const f = climateDeltaFactors([{ lat: -33, weight: 2, baseline: c, future: c }]);
		expect(f.rainFactorByMonth).toEqual(ones());
		expect(f.evapFactorByMonth).toEqual(ones());
	});

	it('clamps a factor to 0.5–1.5 with a warning, and a month without baseline rain takes 1', () => {
		const b = flat(10, 25, 10);
		const fut = { ...flat(30, 25, 10), prMm: [30, 2, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10] };
		const f = climateDeltaFactors([{ lat: -33, weight: 1, baseline: { ...b, prMm: [10, 10, 0, 10, 10, 10, 10, 10, 10, 10, 10, 10] }, future: fut }]);
		expect(f.rawRainFactorByMonth[0]).toBe(3);
		expect(f.rainFactorByMonth[0]).toBe(1.5);
		expect(f.rainFactorByMonth[1]).toBe(0.5);
		expect(f.rainFactorByMonth[2]).toBe(1);
		expect(f.warnings).toEqual([
			'March: no rain in the baseline window, so its rain factor is 1',
			'January: the rain factor 3 is outside 0.5–1.5, so it is held at 1.5',
			'February: the rain factor 0.2 is outside 0.5–1.5, so it is held at 0.5'
		]);
	});

	it('refuses a catchment outside the grid', () => {
		expect(() => climateDeltaFactors([{ lat: -33, weight: 0, baseline: flat(1, 20, 10), future: flat(1, 20, 10) }])).toThrow(/outside the climate grid/);
	});

	it("a window's climate is the mean of its years, and a missing year is refused", () => {
		const yr = (year: number, k: number) => ({ year, ...flat(k, 20 + k, 10) });
		const c = windowClimate([yr(2000, 1), yr(2001, 3), yr(2002, 100)], 2000, 2001);
		expect(c.prMm[0]).toBe(2);
		expect(c.tasmaxC[5]).toBe(22);
		expect(() => windowClimate([yr(2000, 1)], 2000, 2001)).toThrow(/no year 2001/);
	});
});

describe('the climate.delta op', () => {
	it('validates: 12 factors 0.5–1.5 each way, a label and a source', () => {
		const ok = validateScenarioOps([delta(ones())]);
		expect(ok.errors).toEqual([]);
		expect(ok.ops[0]).toEqual(delta(ones()));
		const bad = validateScenarioOps([
			{ ...delta(ones()), rainFactorByMonth: [1, 1] },
			{ ...delta(ones()), evapFactorByMonth: [...ones().slice(1), 1.6] },
			{ ...delta(ones()), label: ' ' }
		]);
		expect(bad.errors).toEqual([
			'ops[0].rainFactorByMonth: must be 12 monthly factors (January–December)',
			'ops[1].evapFactorByMonth: month 12: must be from 0.5 to 1.5',
			'ops[2].label: must be a label of 1–200 characters',
			'ops[1]: a scenario holds at most one climate.delta (op 1 is one)',
			'ops[2]: a scenario holds at most one climate.delta (op 1 is one)'
		]);
	});

	it('never writes a series key a plain object answers from its prototype (a JSON-parsed __proto__)', () => {
		const d = base();
		const hostile = JSON.parse(`{"__proto__": ${JSON.stringify({ startDate: '2020-01-01', values: [1, 2] })}}`) as Record<string, unknown>;
		d.series = { ...(d.series as Record<string, unknown>), ...hostile } as ModelInput['series'];
		applyClimateDelta(d, { rainFactorByMonth: ones().map(() => 1.1), evapFactorByMonth: ones() });
		expect(Object.getPrototypeOf(d.series)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).values).toBeUndefined();
		// Kept as the own data property it arrived as, unscaled (it is no rain or evap kind).
		expect(Object.getOwnPropertyDescriptor(d.series, '__proto__')?.value).toEqual({ startDate: '2020-01-01', values: [1, 2] });
	});

	it('refuses a series.scale beside it, in either order', () => {
		const s: ScenarioOp = { op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.9 };
		expect(validateScenarioOps([s]).errors).toEqual([]);
		expect(validateScenarioOps([s, delta(ones())]).errors[0]).toMatch(/^ops\[0\]: op 2 \(climate\.delta\) already scales/);
		expect(validateScenarioOps([delta(ones()), s]).errors[0]).toMatch(/^ops\[1\]: op 1 \(climate\.delta\) already scales every rain and evaporation series/);
	});

	it('scales every rain series by its days’ calendar month, the evaporation inputs, and the MAPs by the annual factor', () => {
		const rain = ones();
		rain[0] = 1.2; // January
		rain[1] = 0.6; // February
		const evap = ones();
		evap[0] = 1.1;
		evap[9] = 1.3; // October: the A-pan row's first month
		const b = base();
		const before = JSON.stringify(b);
		const r = applyScenario(b, [delta(rain, evap)]);
		expect(r.problems).toEqual([]);
		const s = r.input.series as Record<string, { values: (number | null)[] }>;
		// 30, 31 January × 1.2; 1, 2 February × 0.6; a blank and a no-data code stay as they were.
		expect(s.rain_catchment_mm!.values).toEqual([12, null, 4 * 0.6, -9]);
		expect(s.rain_chirps_mm!.values).toEqual([8 * 1.2, 2 * 1.2, 3 * 0.6, 1 * 0.6]);
		expect(s['rain_chirps_mm@u']!.values).toEqual([6, 3]);
		expect(s['rain_station_mm#s1']!.values).toEqual([1.2, 1.2, 0.6, 0.6]);
		expect(s.evap_apan_mm!.values).toEqual([6 * 1.1, 6]);
		// Flow records are measurements, never scaled.
		expect(s.flow_observed_m3s!.values).toEqual([1, 1, 1, 1]);
		const st = r.input.settings as unknown as Record<string, unknown> & { apanMm: number[]; pe: { mm: number[] } };
		expect(st.apanMm[0]).toBeCloseTo(130, 12); // October × 1.3
		expect(st.apanMm[3]).toBeCloseTo(130 * 1.1, 12); // January × 1.1
		expect(st.apanMm[4]).toBe(140); // February × 1
		expect(st.pe.mm[3]).toBeCloseTo(130 * 1.1, 12);
		// The annual factor from the catchment rain's months: January 10 mm a day, February 4 (the no-data code left out);
		// the months without a reading weigh nothing.
		const k = (10 * 31 * 1.2 + 4 * 28.25 * 0.6) / (10 * 31 + 4 * 28.25);
		expect(annualRainFactor(b.series, rain)).toBeCloseTo(k, 12);
		expect(r.input.model.nodes[0]!.mapMm).toBeCloseTo(700 * k, 9);
		expect((st.unitRain as { gaugeMapMm: number }).gaugeMapMm).toBeCloseTo(600 * k, 9);
		expect((st.rainStations as { catchmentMapMm: number }).catchmentMapMm).toBeCloseTo(500 * k, 9);
		expect(r.input.stations!.s1!.mapMm).toBeCloseTo(400 * k, 9);
		expect(r.applied[0]!.notes).toEqual(['4 rain series scaled', '1 daily evaporation series, the A-pan row, the monthly PE row scaled', `4 MAPs × ${Number(k.toPrecision(4))} (the annual rain factor)`]);
		// The base is untouched.
		expect(JSON.stringify(b)).toBe(before);
	});

	it("reads each day's calendar month the same in any time zone (rule 7)", () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const rain = Array.from({ length: 12 }, (_, m) => 0.5 + m / 11);
		const all = () => JSON.stringify(applyScenario(base(), [delta(rain, rain)]).input);
		try {
			env.TZ = 'Pacific/Kiritimati';
			const east = all();
			env.TZ = 'Pacific/Pago_Pago';
			const west = all();
			env.TZ = 'UTC';
			expect(east).toBe(all());
			expect(west).toBe(all());
		} finally {
			env.TZ = tz;
		}
	});

	it('with every factor 1 the input is the base, value for value', () => {
		const b = base();
		const r = applyScenario(b, [delta(ones())]);
		expect(r.problems).toEqual([]);
		expect(r.input).toStrictEqual(b);
	});

	it('is a baseline assumption, even with the applicant owning every node', () => {
		expect(classifyOp(delta(ones()), ['u', 'g'])).toBe('baseline');
	});

	it('conflicts with another scenario’s climate, series scaling, A-pan row or PE row', () => {
		const b = base();
		const c = (ops: ScenarioOp[]) => scenarioConflicts(b, [{ id: 'a', name: 'Future', ops: [delta(ones())] }, { id: 'b', name: 'Other', ops }]).map((x) => x.message);
		expect(c([{ op: 'series.scale', kind: 'rain_chirps_mm', factor: 0.9 }])).toEqual(['"Future" op 1 (climate.delta) and "Other" op 1 (series.scale) both change series rain_chirps_mm']);
		expect(c([delta(ones())])[0]).toMatch(/both change every rain and evaporation series/);
		expect(c([{ op: 'settings.set', path: 'apanMm', value: ones() }])).toEqual(['"Future" op 1 (climate.delta) and "Other" op 1 (settings.set) both change settings: apanMm']);
		expect(c([{ op: 'demand.scale', factor: 0.9 }])).toEqual([]);
	});
});
