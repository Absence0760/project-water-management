// A-pan per hydrological unit (engine ≥ 1.117.0, ./evaporation/apanUnits.ts,
// docs/model.md §2.3b): bit-identical to the one catchment row when every unit
// is given that row; a unit with more A-pan makes less runoff and needs more
// water, its dam loses more; uncovered units, dams off the units and the
// catchment readers take the covered units' rows area-weighted; the daily
// A-pan series is not read; every invariant holds on random networks; fit
// provenance and scenarios follow it.
import { describe, expect, it } from 'vitest';
import { apanUnitsError, areaWeightedApan, catchmentApanMm, resolveApanUnits, scaleApanUnits, unitsWithoutGridApan, type ApanUnitsSettings } from './evaporation/apanUnits';
import { fitRecordCaveats, fitRecordStatus, type FitRecord } from './calibrate/provenance';
import type { ModelInput, ModelOutput, NetworkNode } from './project';
import { runModel } from './run';
import { applyScenario } from './scenario/overrides';
import { randomInput, withUnitRain } from './testing/fuzz';
import { checkAll } from './testing/invariants';

const CASES = Number(process.env.APAN_UNITS_CASES ?? 24);

const isLand = (n: NetworkNode) => n.kind === 'farm' && n.areaKm2 > 0;
const grid = (units: Record<string, number[]>): ApanUnitsSettings => ({ dataset: 'synthetic', source: 'synthetic A-pan grid, area-weighted over each unit’s parcel', units });

/** A random per-unit input with no daily A-pan series (the per-unit grid doesn't read one, so the base mustn't either). */
function base(seed: number): ModelInput {
	const input = withUnitRain(randomInput(seed, { maxDays: 900 }), seed);
	delete (input.series as Record<string, unknown>).evap_apan_mm;
	// The generator draws the per-unit A-pan itself now and then: each test here sets its own.
	delete input.settings.apanBasis;
	delete input.settings.apanUnits;
	return input;
}

/** The output with the summary's per-unit A-pan record and the warnings left out: what must match the catchment row's run. */
function withoutRecord(o: ModelOutput): unknown {
	const { apanUnits: _a, warnings: _w, warningCodes: _c, ...summary } = o.summary as ModelOutput['summary'] & { warningCodes?: unknown };
	return { ...o, summary };
}

function sameBits(a: ModelOutput, b: ModelOutput): string | null {
	if (a.series.length !== b.series.length) return 'series count';
	for (let i = 0; i < a.series.length; i++) {
		const x = a.series[i]!;
		const y = b.series[i]!;
		if (x.key !== y.key || x.nodeId !== y.nodeId) return `series ${i}: ${x.key} vs ${y.key}`;
		for (let t = 0; t < x.values.length; t++) if (!Object.is(x.values[t], y.values[t])) return `${x.nodeId ?? 'catchment'} ${x.key} day ${t}: ${x.values[t]} vs ${y.values[t]}`;
	}
	return JSON.stringify(withoutRecord(a)) === JSON.stringify(withoutRecord(b)) ? null : 'summary';
}

describe('A-pan per hydro unit: the one catchment row, to the bit', () => {
	it('every land unit given the catchment row runs as that row does, whatever the typed row holds', () => {
		let compared = 0;
		for (let seed = 1; seed <= CASES; seed++) {
			const input = base(seed);
			const land = input.model.nodes.filter(isLand);
			if (!land.length) continue;
			let want: ModelOutput;
			try {
				want = runModel(input);
			} catch {
				continue;
			}
			const row = [...input.settings.apanMm!];
			const per = structuredClone(input);
			per.settings.apanBasis = 'units';
			per.settings.apanUnits = grid(Object.fromEntries(land.map((n) => [n.id, [...row]])));
			// The typed row is kept but not read under the grid.
			per.settings.apanMm = row.map((v) => v * 3 + 7) as never;
			const got = runModel(per);
			expect(sameBits(got, want), `seed ${seed}`).toBeNull();
			expect(got.summary.apanUnits?.units.every((u) => u.covered)).toBe(true);
			expect(got.summary.apanUnits?.catchmentMm).toEqual(row);
			compared++;
		}
		expect(compared).toBeGreaterThan(CASES / 3);
	}, 300_000);

	it('the catchment basis (absent, null or catchment) runs on the typed row to the bit, whatever rows are stored', () => {
		for (let seed = 1; seed <= 6; seed++) {
			const input = base(seed);
			const land = input.model.nodes.filter(isLand);
			let want: ModelOutput;
			try {
				want = runModel(input);
			} catch {
				continue;
			}
			for (const basis of [undefined, null, 'catchment'] as const) {
				const i = structuredClone(input);
				i.settings.apanBasis = basis;
				i.settings.apanUnits = grid(Object.fromEntries(land.map((n) => [n.id, input.settings.apanMm!.map((v) => v * 2 + 5)])));
				const got = runModel(i);
				expect(sameBits(got, want), `seed ${seed} ${basis}`).toBeNull();
				expect(got.summary.warnings).toEqual(want.summary.warnings);
				expect(got.summary.apanUnits).toBeUndefined();
			}
		}
	}, 300_000);

	it('the units basis with no rows stored runs on the typed row, saying why', () => {
		const input = base(3);
		const want = runModel(input);
		const i = structuredClone(input);
		i.settings.apanBasis = 'units';
		const out = runModel(i);
		expect(sameBits(out, want)).toBeNull();
		expect(out.summary.warnings.some((w) => w.startsWith('each unit’s own A-pan is chosen'))).toBe(true);
	});

	it('an absent, null or unusable setting runs on the typed row as before', () => {
		const input = base(3);
		input.settings.apanBasis = 'units';
		const want = runModel(base(3));
		for (const v of [undefined, null]) {
			const i = structuredClone(input);
			i.settings.apanUnits = v;
			expect(sameBits(runModel(i), want)).toBeNull();
		}
		const bad = structuredClone(input);
		(bad.settings as Record<string, unknown>).apanUnits = { dataset: 'x', source: 'y', units: { a: [1, 2] } };
		const out = runModel(bad);
		expect(sameBits(out, want)).toBeNull();
		expect(out.summary.warnings.some((w) => w.startsWith('the A-pan per hydro unit is not used'))).toBe(true);
	});
});

describe('A-pan per hydro unit on random networks', () => {
	it('every invariant holds with units on rows of their own and some uncovered', () => {
		const fails: string[] = [];
		let ran = 0;
		for (let seed = 1; seed <= CASES; seed++) {
			const input = base(seed);
			const land = input.model.nodes.filter(isLand);
			if (!land.length) continue;
			const row = input.settings.apanMm!;
			// Every other unit covered, each at its own multiple of the row.
			const units = Object.fromEntries(land.filter((_, k) => k % 2 === 0).map((n, k) => [n.id, row.map((v) => v * (0.6 + 0.2 * k))]));
			input.settings.apanBasis = 'units';
			input.settings.apanUnits = grid(units);
			const r = checkAll(input, seed);
			if (r) fails.push(`${seed}: ${r}`);
			ran++;
		}
		expect(fails.slice(0, 10)).toEqual([]);
		expect(ran).toBeGreaterThan(CASES / 3);
	}, 600_000);
});

// ---------------------------------------------------------------------------
// A hand-made catchment: two land units A (dam, crops) and B (crops) drain to
// a dam D with no land, then to the outlet gauge G.
// ---------------------------------------------------------------------------

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: 0,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 0.8,
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const ROW = [120, 150, 190, 210, 190, 160, 110, 80, 60, 60, 80, 100];
const dam = { damCapacityM3: 200_000, damInitialPct: 0.6, damAreaFullM2: 60_000, pctRunoffToDam: 0.5, pctUpstreamToDam: 1 };

function catchment(): ModelInput {
	const days = 3 * 365;
	// A wet season and a dry one, every day of three years.
	const rain = Array.from({ length: days }, (_, t) => {
		const m = new Date(Date.UTC(2010, 9, 1) + t * 86_400_000).getUTCMonth();
		const wet = m >= 9 || m <= 2;
		return (t * 7919) % 11 === 0 ? (wet ? 25 : 8) : (t * 31) % 5 === 0 ? (wet ? 6 : 1) : 0;
	});
	return {
		settings: { apanMm: ROW as never, simulationStart: '2010-10-01', simulationEnd: '2013-09-30', unitRain: { mode: 'perUnit' }, gr4j: { x1: 300, x2: 0, x3: 60, x4: 1.5, warmupDays: 365 } },
		model: {
			nodes: [node('G', 'gauge', null), node('D', 'farm', 'G', dam), node('A', 'farm', 'D', { areaKm2: 30, ...dam }), node('B', 'farm', 'D', { areaKm2: 10 })],
			crops: [{ id: 'c', name: 'Lucerne', cropFactor: ROW.map(() => 0.9) }],
			cropAreas: [
				{ nodeId: 'A', cropId: 'c', areaM2: 400_000 },
				{ nodeId: 'B', cropId: 'c', areaM2: 400_000 }
			],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2010-10-01', values: rain } }
	};
}

const unit = (o: ModelOutput, id: string) => o.summary.unitRain!.units.find((u) => u.nodeId === id)!;
const farm = (o: ModelOutput, id: string) => o.summary.farms.find((f) => f.nodeId === id)!;
const total = (o: ModelOutput, id: string, key: string) => (o.series.find((s) => s.nodeId === id && s.key === key)?.values ?? []).reduce((s, v) => s + v, 0);
const scaled = (k: number) => ROW.map((v) => v * k);
const MONTH_DAYS = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30];
/** The open-water depth (mm/day) a row gives each water-year month: 0.75 × the month ÷ its days, to 9 places. */
const depthOf = (row: readonly number[]) => row.map((v, m) => Math.round(((0.75 * v) / MONTH_DAYS[m]!) * 1e9) / 1e9);
/** A dam's evaporation ÷ its area each water-year month (mm/day, to 9 places), from the days it had water. */
function evapDepth(o: ModelOutput, id: string): number[] {
	const ev = o.series.find((s) => s.nodeId === id && s.key === 'dam_evaporation')!.values;
	const area = o.series.find((s) => s.nodeId === id && s.key === 'dam_area')!.values;
	const out = new Array<number>(12).fill(Number.NaN);
	const d0 = Date.UTC(2010, 9, 1);
	for (let t = 0; t < ev.length; t++) {
		if (!(area[t]! > 0)) continue;
		const wy = (new Date(d0 + t * 86_400_000).getUTCMonth() + 3) % 12;
		out[wy] = Math.round(((ev[t]! * 1000) / area[t]!) * 1e9) / 1e9;
	}
	return out;
}

describe('A-pan per hydro unit, hand-made', () => {
	it('a unit with more A-pan makes less runoff, needs more water and its dam loses more; the other unit is untouched', () => {
		const one = catchment();
		one.settings.apanBasis = 'units';
		one.settings.apanUnits = grid({ A: ROW, B: ROW });
		const more = catchment();
		more.settings.apanBasis = 'units';
		more.settings.apanUnits = grid({ A: scaled(1.4), B: ROW });
		const a = runModel(one);
		const b = runModel(more);
		expect(unit(b, 'A').petMm).toBeCloseTo(unit(a, 'A').petMm * 1.4, 6);
		expect(unit(b, 'A').flowMm).toBeLessThan(unit(a, 'A').flowMm);
		expect(farm(b, 'A').avgCropRequirementM3Day!).toBeGreaterThan(farm(a, 'A').avgCropRequirementM3Day!);
		// A's dam loses its own row's depth over its area (lake factor 0.75 × the month ÷ its days), D's the catchment row's.
		expect(evapDepth(b, 'A')).toEqual(depthOf(scaled(1.4)));
		expect(evapDepth(a, 'A')).toEqual(depthOf(ROW));
		expect(evapDepth(b, 'D')).toEqual(depthOf(b.summary.apanUnits!.catchmentMm));
		// B's own runoff and its crops' need don't read A's row.
		expect(unit(b, 'B').flowMm).toBe(unit(a, 'B').flowMm);
		expect(unit(b, 'B').petMm).toBe(unit(a, 'B').petMm);
		expect(farm(b, 'B').avgCropRequirementM3Day).toBe(farm(a, 'B').avgCropRequirementM3Day);
	});

	it('a dam on no unit and an uncovered unit run on the covered units’ rows area-weighted, with a warning naming the unit', () => {
		const per = catchment();
		per.settings.apanBasis = 'units';
		per.settings.apanUnits = grid({ A: scaled(1.5) });
		const out = runModel(per);
		// Only A is covered: the catchment row is A's.
		expect(out.summary.apanUnits!.catchmentMm).toEqual(scaled(1.5));
		expect(out.summary.apanUnits!.units).toEqual([
			{ nodeId: 'A', name: 'A', areaKm2: 30, apanMm: scaled(1.5), covered: true },
			{ nodeId: 'B', name: 'B', areaKm2: 10, apanMm: scaled(1.5), covered: false }
		]);
		expect(out.summary.warnings.find((w) => w.startsWith('A-pan per hydro unit:'))).toMatch(/the unit "B" has no A-pan from synthetic, so it runs on the catchment row/);
		// The same as typing A's row as the catchment row, for B and D.
		const typed = catchment();
		typed.settings.apanMm = scaled(1.5) as never;
		const want = runModel(typed);
		expect(farm(out, 'B').avgCropRequirementM3Day).toBe(farm(want, 'B').avgCropRequirementM3Day);
		expect(total(out, 'D', 'dam_evaporation')).toBe(total(want, 'D', 'dam_evaporation'));
	});

	it('the catchment row is the covered units’ rows weighted by their areas', () => {
		const per = catchment();
		per.settings.apanBasis = 'units';
		per.settings.apanUnits = grid({ A: scaled(1), B: scaled(2) });
		const out = runModel(per);
		// A 30 km², B 10 km²: (1 × 30 + 2 × 10) ÷ 40 = 1.25.
		out.summary.apanUnits!.catchmentMm.forEach((v, m) => expect(v).toBeCloseTo(ROW[m]! * 1.25, 9));
		// The dam on no unit loses what the 1.25 row gives, A's dam its own.
		expect(evapDepth(out, 'D')).toEqual(depthOf(out.summary.apanUnits!.catchmentMm));
		expect(evapDepth(out, 'A')).toEqual(depthOf(ROW));
	});

	it('the daily A-pan series is not read, and the run says so', () => {
		const per = catchment();
		per.settings.apanBasis = 'units';
		per.settings.apanUnits = grid({ A: ROW, B: ROW });
		const want = runModel(per);
		const daily = structuredClone(per);
		daily.series.evap_apan_mm = { startDate: '2010-10-01', values: new Array(3 * 365).fill(30) };
		const got = runModel(daily);
		expect(got.summary.apanDaily).toBeUndefined();
		expect(got.summary.apanUnits!.dailyIgnored).toBe(true);
		expect(got.summary.warnings).toContain('the daily A-pan series is not used: the A-pan comes from synthetic per hydro unit, so every unit runs on its grid’s monthly means on every day');
		expect(farm(got, 'A').avgCropRequirementM3Day).toBe(farm(want, 'A').avgCropRequirementM3Day);
		expect(unit(got, 'A').flowMm).toBe(unit(want, 'A').flowMm);
	});

	it('a setting covering no land unit is not used, with a warning', () => {
		const per = catchment();
		per.settings.apanBasis = 'units';
		per.settings.apanUnits = grid({ gone: scaled(2), D: scaled(2) });
		const out = runModel(per);
		expect(out.summary.apanUnits).toBeUndefined();
		expect(out.summary.warnings.some((w) => w.includes('covers none of the model’s land units'))).toBe(true);
		expect(farm(out, 'A').avgCropRequirementM3Day).toBe(farm(runModel(catchment()), 'A').avgCropRequirementM3Day);
	});

	it('a monthly PE row replaces A-pan for GR4J under the grid too: only demand and the dams read the units’ rows', () => {
		const pe = { kind: 'monthly' as const, mm: ROW.map((v) => v * 0.7) as never, source: 'a station ET₀' };
		const one = catchment();
		one.settings.pe = pe;
		one.settings.apanBasis = 'units';
		one.settings.apanUnits = grid({ A: ROW, B: ROW });
		const more = catchment();
		more.settings.pe = pe;
		more.settings.apanBasis = 'units';
		more.settings.apanUnits = grid({ A: scaled(1.4), B: ROW });
		const a = runModel(one);
		const b = runModel(more);
		expect(unit(b, 'A').flowMm).toBe(unit(a, 'A').flowMm);
		expect(farm(b, 'A').avgCropRequirementM3Day!).toBeGreaterThan(farm(a, 'A').avgCropRequirementM3Day!);
	});
});

describe('A-pan per hydro unit, the module', () => {
	const nodes = [node('A', 'farm', null, { areaKm2: 3 }), node('B', 'farm', null, { areaKm2: 1 }), node('D', 'farm', null), node('U', 'user', null)];

	it('refuses what it can’t use', () => {
		expect(apanUnitsError(null)).toBeNull();
		expect(apanUnitsError(grid({ A: ROW }))).toBeNull();
		expect(apanUnitsError([])).toMatch(/not an A-pan per unit/);
		expect(apanUnitsError({ ...grid({ A: ROW }), dataset: '' })).toMatch(/dataset label/);
		expect(apanUnitsError({ ...grid({ A: ROW }), source: ' ' })).toMatch(/its source/);
		expect(apanUnitsError(grid({}))).toMatch(/names no unit/);
		expect(apanUnitsError(grid({ A: [1, 2, 3] }))).toMatch(/12 months/);
		expect(apanUnitsError(grid({ A: ROW.map((v, m) => (m === 2 ? -1 : v)) }))).toMatch(/12 months/);
		expect(apanUnitsError(grid({ A: ROW.map((v, m) => (m === 2 ? Number.NaN : v)) }))).toMatch(/12 months/);
	});

	it('weights by area, and a month every row agrees on is that month exactly', () => {
		expect(areaWeightedApan([[0.1, 2], [0.1, 4]].map((r) => [...r, ...new Array(10).fill(1)]), [3, 1]).slice(0, 2)).toEqual([0.1, 2.5]);
	});

	it('keeps the rows to the land units, and lists the uncovered ones', () => {
		const w: string[] = [];
		const r = resolveApanUnits({ apanBasis: 'units', apanUnits: grid({ A: ROW, D: scaled(9), gone: scaled(9) }) }, nodes, false, w)!;
		expect(Object.keys(r.setting.units)).toEqual(['A']);
		expect(r.catchmentMm).toEqual(ROW);
		expect(w).toHaveLength(1);
		expect(unitsWithoutGridApan(nodes, { apanBasis: 'units', apanUnits: grid({ A: ROW }) }).map((n) => n.id)).toEqual(['B']);
		// Under the catchment row nothing is missing; under 'units' with none stored, every land unit is.
		expect(unitsWithoutGridApan(nodes, { apanUnits: grid({ A: ROW }) })).toEqual([]);
		expect(unitsWithoutGridApan(nodes, { apanBasis: 'units', apanUnits: null }).map((n) => n.id)).toEqual(['A', 'B']);
		expect(catchmentApanMm({ apanMm: scaled(2), apanBasis: 'units', apanUnits: grid({ A: ROW, B: scaled(3) }) }, nodes).map((v, m) => v / ROW[m]!)).toEqual(new Array(12).fill(1.5));
		expect(catchmentApanMm({ apanMm: scaled(2), apanBasis: 'units', apanUnits: null }, nodes)).toEqual(scaled(2));
		expect(catchmentApanMm({ apanMm: scaled(2), apanUnits: grid({ A: ROW, B: scaled(3) }) }, nodes)).toEqual(scaled(2));
	});

	it('scales every unit by the scenario’s change to the catchment row, and refuses a month with none', () => {
		const s = grid({ A: ROW, B: scaled(2) });
		const r = scaleApanUnits(s, scaled(1.25), scaled(1.25 * 1.1));
		if (!('setting' in r)) throw new Error(r.problem);
		r.setting.units.A!.forEach((v, m) => expect(v).toBeCloseTo(ROW[m]! * 1.1, 9));
		r.setting.units.B!.forEach((v, m) => expect(v).toBeCloseTo(ROW[m]! * 2.2, 9));
		// A month the row leaves as it was keeps every unit's value exactly.
		expect(scaleApanUnits(s, ROW, ROW)).toEqual({ setting: s });
		const zero = ROW.map((v, m) => (m === 0 ? 0 : v));
		expect(scaleApanUnits(s, zero, ROW)).toEqual({ problem: expect.stringMatching(/0 in month 1/) });
	});
});

describe('A-pan per hydro unit in scenarios', () => {
	it('a new A-pan row scales every unit’s row by the same factor, and the run follows it', () => {
		const per = catchment();
		per.settings.apanBasis = 'units';
		per.settings.apanUnits = grid({ A: ROW, B: scaled(2) });
		// The base's catchment row: (1 × 30 + 2 × 10) ÷ 40 = 1.25 × ROW; the scenario puts 10 % on it.
		const next = scaled(1.25 * 1.1);
		const { input, applied, problems } = applyScenario(per, [{ op: 'settings.set', path: 'apanMm', value: next }]);
		expect(problems).toEqual([]);
		const notes = applied.flatMap((a) => a.notes);
		const units = input.settings.apanUnits!.units;
		units.A!.forEach((v, m) => expect(v).toBeCloseTo(ROW[m]! * 1.1, 9));
		units.B!.forEach((v, m) => expect(v).toBeCloseTo(ROW[m]! * 2.2, 9));
		expect(notes.join(' ')).toMatch(/every unit’s row scaled/);
		const out = runModel(input);
		out.summary.apanUnits!.catchmentMm.forEach((v, m) => expect(v).toBeCloseTo(next[m]!, 9));
		expect(farm(out, 'A').avgCropRequirementM3Day!).toBeGreaterThan(farm(runModel(per), 'A').avgCropRequirementM3Day!);
	});

	it('a climate change scales every unit’s row', () => {
		const per = catchment();
		per.settings.apanBasis = 'units';
		per.settings.apanUnits = grid({ A: ROW, B: ROW });
		const { input } = applyScenario(per, [{ op: 'climate.delta', rainFactorByMonth: new Array(12).fill(1), evapFactorByMonth: new Array(12).fill(1.2) } as never]);
		input.settings.apanUnits!.units.A!.forEach((v, m) => expect(v).toBeCloseTo(ROW[m]! * 1.2, 9));
	});

	it('refuses to scale the daily A-pan series, which the grid doesn’t read', () => {
		const per = catchment();
		per.settings.apanBasis = 'units';
		per.settings.apanUnits = grid({ A: ROW, B: ROW });
		per.series.evap_apan_mm = { startDate: '2010-10-01', values: new Array(30).fill(5) };
		const { problems, input } = applyScenario(per, [{ op: 'series.scale', kind: 'evap_apan_mm', factor: 1.1 }]);
		expect(problems).toEqual([expect.stringMatching(/doesn’t read the daily A-pan series/)]);
		expect(input.series.evap_apan_mm).toBe(per.series.evap_apan_mm);
	});
});

describe('A-pan per hydro unit in fit provenance', () => {
	const record = (apanUnits?: FitRecord['forcing'] extends infer F ? (F extends { apanUnits?: infer A } ? A : never) : never): FitRecord =>
		({ model: 'gr4j', params: {}, free: [], calibrationStart: null, calibrationEnd: null, flowKind: 'observed_flow_m3s', forcing: { panCoefficient: new Array(12).fill(0.7), apanMm: ROW, ...(apanUnits !== undefined ? { apanUnits } : {}) } }) as unknown as FitRecord;
	const settings = (apanUnits: ApanUnitsSettings | null) => ({ panCoefficient: new Array(12).fill(0.7), apanMm: ROW, apanBasis: 'units', apanUnits }) as never;

	it('a grid set, changed or cleared since the fit is a forcing change with its own caveat', () => {
		const set = fitRecordStatus(settings(grid({ A: ROW })), record());
		expect(set.apanUnitsChanged).toBe(true);
		expect(set.forcingChanged).toBe(true);
		expect(fitRecordCaveats(set).join(' ')).toMatch(/The A-pan per hydro unit has been set, cleared or changed since the fit/);
		expect(fitRecordStatus(settings(grid({ A: scaled(1.1) })), record({ dataset: 'synthetic', units: { A: ROW } })).apanUnitsChanged).toBe(true);
		expect(fitRecordStatus(settings(null), record({ dataset: 'synthetic', units: { A: ROW } })).apanUnitsChanged).toBe(true);
	});

	it('the same grid is no change, and the unread typed row isn’t one either', () => {
		const same = fitRecordStatus({ ...(settings(grid({ A: ROW })) as object), apanMm: scaled(2) } as never, record({ dataset: 'synthetic', units: { A: ROW } }));
		expect(same.apanUnitsChanged).toBeUndefined();
		expect(same.forcingChanged).toBe(false);
	});
});
