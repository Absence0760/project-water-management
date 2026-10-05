// Crop demand options (engine 0.43.0, issue #54 item 1, docs/model.md §2.3):
// an irrigation efficiency per crop, falling back to the farm's, and a
// monthly effective-rain fraction in place of the one annual fraction. Both
// optional: absent, a run is bit-for-bit what it was. Tiny synthetic farms,
// expected values worked by hand.
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import type { CropArea, CropDef, ModelInput, NetworkNode, ProjectSettings, RunSeries } from './project';
import { runModel, runModelWith } from './run';
import { randomInput } from './testing/fuzz';
import { checkAll } from './testing/invariants';

const zeros = new Array(12).fill(0) as unknown as Monthly;
const flat = (v: number) => new Array(12).fill(v) as unknown as Monthly;

function farm(over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id: 'F',
		name: 'F',
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		// A full dam far bigger than any demand here: every farm is fully supplied.
		damCapacityM3: 1e7,
		damInitialPct: 1,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 0.8,
		returnFlowFraction: 0.2,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

interface Fixture {
	node?: Partial<NetworkNode>;
	crops: CropDef[];
	cropAreas: CropArea[];
	settings?: Partial<ProjectSettings>;
	startDate: string;
	rain: number[];
}

function input(f: Fixture): ModelInput {
	return {
		// 3100 mm of A-pan a month: × crop factor 1 over 1000 m² is 100 m³/day in a 31-day month.
		settings: { ewrPragmaticM3PerDay: zeros, apanMm: flat(3100), lakeEvapFactor: 0, effectiveRainStoreMm: 0, ...f.settings },
		model: { nodes: [farm(f.node)], crops: f.crops, cropAreas: f.cropAreas, transfers: [] },
		series: { rain_catchment_mm: { startDate: f.startDate, values: f.rain } }
	};
}

const run = (x: ModelInput) => runModelWith(x, () => ({ naturalFlowM3Day: new Array((x.series!.rain_catchment_mm as { values: number[] }).values.length).fill(0) }));

function get(out: { series: RunSeries[] }, key: string, nodeId: string | null = 'F'): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}

const crop = (id: string, over: Partial<CropDef> = {}): CropDef => ({ id, name: `Crop ${id}`, cropFactor: [...flat(1)], ...over });

describe('irrigation efficiency per crop (engine 0.43.0)', () => {
	const twoCrops = (a: Partial<CropDef>, b: Partial<CropDef> = {}): Fixture => ({
		crops: [crop('a', a), crop('b', b)],
		cropAreas: [
			{ nodeId: 'F', cropId: 'a', areaM2: 1000 },
			{ nodeId: 'F', cropId: 'b', areaM2: 1000 }
		],
		startDate: '2020-10-01',
		rain: [0]
	});

	it('abstracts each crop’s requirement ÷ its own efficiency, the farm’s for the rest (hand-computed)', () => {
		// Two crops of 100 m³/day each in October. a is under flood (0.5), b takes the farm's 0.8:
		// D = 100 / 0.5 + 100 / 0.8 = 200 + 125 = 325 m³/day.
		const out = run(input(twoCrops({ irrigationEfficiency: 0.5 })));
		expect(get(out, 'crop_requirement')[0]).toBe(200);
		expect(get(out, 'demand')[0]).toBeCloseTo(325, 9);
		// Fully supplied; the farm's return flow r = 0.2 is a share of all the water supplied (engine ≥ 1.71.0),
		// within the blend's losses (1 − 200/325): 65 of the 125 m³ lost return, and consumptive use is 260.
		const G = get(out, 'supplied')[0]!;
		expect(G).toBeCloseTo(325, 9);
		expect(get(out, 'return_flow')[0]).toBeCloseTo(0.2 * 325, 9);
		expect(G - get(out, 'return_flow')[0]!).toBeCloseTo(260, 9);
		expect(Math.abs(get(out, 'balance_residual')[0]!)).toBeLessThan(1e-9);
		expect(out.summary.warnings.filter((w) => w.includes('efficiency'))).toEqual([]);
	});

	it('a model saved by engine 0.43.0–1.70.0 (β, a share of the losses) returns what that engine did: β at the blend', () => {
		// The same unit stored with β = 1 and no r: 1.70.0 returned all of the blend's losses, 325 − 200 = 125 m³/day,
		// not β(1 − 0.8) × 325 = 65 at the unit's own efficiency (upgradeLegacyInput).
		const x = input(twoCrops({ irrigationEfficiency: 0.5 }));
		x.model.nodes = x.model.nodes.map((n) => {
			if (n.id !== 'F') return n;
			const { returnFlowFraction: _r, ...rest } = n;
			return { ...rest, lossReturnFraction: 1 } as unknown as typeof n;
		});
		expect(get(run(x), 'return_flow')[0]).toBeCloseTo(125, 9);
	});

	it('both crops with their own efficiency ignore the farm’s', () => {
		const out = run(input(twoCrops({ irrigationEfficiency: 0.5 }, { irrigationEfficiency: 1 })));
		expect(get(out, 'demand')[0]).toBeCloseTo(300, 9); // 200 + 100
		const alt = run(input({ ...twoCrops({ irrigationEfficiency: 0.5 }, { irrigationEfficiency: 1 }), node: { irrigationEfficiency: 0.3 } }));
		expect(get(alt, 'demand')).toEqual(get(out, 'demand'));
	});

	it('crops that don’t set one (absent or null) run exactly as before', () => {
		const before = run(input(twoCrops({})));
		const nulls = run(input(twoCrops({ irrigationEfficiency: null }, { irrigationEfficiency: null })));
		expect(get(before, 'demand')).toEqual([250]); // 200 / 0.8
		expect(nulls.series).toEqual(before.series);
		expect(nulls.summary).toEqual(before.summary);
	});

	it('warns and uses the farm’s efficiency for a crop efficiency outside (0, 1]', () => {
		for (const bad of [0, -0.2, 1.5]) {
			const out = run(input(twoCrops({ irrigationEfficiency: bad })));
			expect(get(out, 'demand')[0]).toBeCloseTo(250, 9);
			expect(out.summary.warnings).toContain(`crop "Crop a": irrigation efficiency ${bad} is not in (0, 1]; using the unit's`);
		}
	});

	it('lowering a crop’s or a farm’s efficiency never lowers the farm’s demand on any day (invariant)', () => {
		let tested = 0;
		for (let seed = 1; seed <= 60; seed++) {
			const x = randomInput(seed, { maxDays: 120, allocationModes: false });
			if (!x.model.crops.some((c) => c.irrigationEfficiency != null)) continue;
			tested++;
			// Worse systems: every crop's own efficiency and, every other seed, every farm's too.
			const lower = structuredClone(x);
			for (const c of lower.model.crops) if (c.irrigationEfficiency != null) c.irrigationEfficiency *= 0.8;
			if (seed % 2) for (const n of lower.model.nodes) n.irrigationEfficiency *= 0.8;
			const a = runModel(x);
			const b = runModel(lower);
			for (const n of x.model.nodes) {
				if (n.kind !== 'farm') continue;
				const da = get(a, 'demand', n.id);
				const db = get(b, 'demand', n.id);
				// The crop requirement doesn't depend on the efficiency; only the abstraction does.
				expect(get(b, 'crop_requirement', n.id)).toEqual(get(a, 'crop_requirement', n.id));
				for (let t = 0; t < da.length; t++) expect(db[t]!, `seed ${seed} ${n.id} day ${t}`).toBeGreaterThanOrEqual(da[t]! * (1 - 1e-12));
			}
		}
		expect(tested).toBeGreaterThan(10);
	});
});

describe('monthly effective-rain fraction (engine 0.43.0)', () => {
	const oneCrop = (settings: Partial<ProjectSettings>, rain = [20, 20]): Fixture => ({
		crops: [crop('a')],
		cropAreas: [{ nodeId: 'F', cropId: 'a', areaM2: 1000 }],
		settings,
		// 31 Oct and 1 Nov: one day in each month.
		startDate: '2020-10-31',
		rain
	});
	const oct05nov025 = [0.5, 0.25, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65] as unknown as Monthly;

	it('replaces the annual fraction month by month (hand-computed)', () => {
		// Pe = 1000 m² × fraction ÷ 1000 × 20 mm: October 0.5 → 10 m³, November 0.25 → 5 m³.
		// Gross: 3100 / 31 = 100 m³/day in October, 3100 / 30 × 1 ≈ 103.33 in November.
		const out = run(input(oneCrop({ effectiveRainFraction: 0.65, effectiveRainFractionMonthly: oct05nov025 })));
		expect(get(out, 'effective_rain')).toEqual([10, 5]);
		expect(get(out, 'crop_requirement')[0]).toBe(90);
		expect(get(out, 'crop_requirement')[1]).toBeCloseTo(3100 / 30 - 5, 9);
		// The annual 0.65 would have given 13 m³ each day.
		const annual = run(input(oneCrop({ effectiveRainFraction: 0.65 })));
		expect(get(annual, 'effective_rain')).toEqual([13, 13]);
	});

	it('still carries effective rain over through the soil-water store', () => {
		// 25 mm store over 1000 m² = 25 m³. Day 1 rains 400 mm at Oct 0.5: Pe = 200, uses 100, keeps 25; day 2 draws them.
		const out = run(input(oneCrop({ effectiveRainStoreMm: 25, effectiveRainFractionMonthly: oct05nov025 }, [400, 0])));
		expect(get(out, 'effective_rain')).toEqual([100, 25]);
		expect(get(out, 'soil_water')).toEqual([25, 0]);
	});

	it('null, absent, or the annual fraction in every month run exactly as the annual fraction', () => {
		const before = run(input(oneCrop({ effectiveRainFraction: 0.65 })));
		for (const m of [null, flat(0.65)]) {
			const out = run(input(oneCrop({ effectiveRainFraction: 0.65, effectiveRainFractionMonthly: m })));
			expect(out.series).toEqual(before.series);
			expect(out.summary.warnings).toEqual(before.summary.warnings);
		}
	});

	it('warns and falls back to the annual fraction for a row that isn’t 12 fractions', () => {
		for (const bad of [[0.5], [...flat(0.5).slice(0, 11), 1.2], [...flat(0.5).slice(0, 11), -0.1], 'monthly']) {
			const out = run(input(oneCrop({ effectiveRainFraction: 0.65, effectiveRainFractionMonthly: bad as never })));
			expect(get(out, 'effective_rain')).toEqual([13, 13]);
			expect(out.summary.warnings).toContain('monthly effective rain fractions should be 12 numbers from 0 to 1; using 0.65 in every month');
		}
	});

	it('runs a row of zeros as given, but says rain never reduces demand (never a silent default)', () => {
		const out = run(input(oneCrop({ effectiveRainFraction: 0.65, effectiveRainFractionMonthly: flat(0) })));
		expect(get(out, 'effective_rain')).toEqual([0, 0]);
		expect(get(out, 'crop_requirement')[0]).toBe(100);
		expect(out.summary.warnings).toContain('the monthly effective rain fraction is 0 in every month, so rain never reduces irrigation demand');
	});

	it('keeps effective rain between 0 and the day’s rain on the cropped area, and a higher fraction never raises demand (invariant)', () => {
		for (let seed = 1; seed <= 40; seed++) {
			const x = randomInput(seed, { maxDays: 150, allocationModes: false });
			const lo = structuredClone(x);
			const hi = structuredClone(x);
			const f = Array.from({ length: 12 }, (_, m) => ((seed * 7 + m * 3) % 10) / 10);
			lo.settings.effectiveRainFractionMonthly = f as unknown as Monthly;
			hi.settings.effectiveRainFractionMonthly = f.map((v) => Math.min(1, v + 0.2)) as unknown as Monthly;
			const a = runModel(lo);
			const b = runModel(hi);
			const rain = get(a, 'rain_final', null);
			const thr = x.settings.calibration?.rainThresholdMm ?? 2;
			for (const n of x.model.nodes) {
				if (n.kind !== 'farm') continue;
				const area = x.model.cropAreas.filter((r) => r.nodeId === n.id && x.model.crops.some((c) => c.id === r.cropId)).reduce((s, r) => s + r.areaM2, 0);
				const ea = get(a, 'effective_rain', n.id);
				const fa = get(a, 'crop_requirement', n.id);
				const fb = get(b, 'crop_requirement', n.id);
				let pe = 0;
				let used = 0;
				for (let t = 0; t < ea.length; t++) {
					const r = Number.isFinite(rain[t]!) && rain[t]! > thr ? rain[t]! : 0;
					pe += (area * r) / 1000;
					used += ea[t]!;
					expect(ea[t]!).toBeGreaterThanOrEqual(0);
					// Never more than all the rain so far on the cropped area (fraction ≤ 1; the store only holds what fell).
					expect(used).toBeLessThanOrEqual(pe * (1 + 1e-9) + 1e-9);
					expect(fb[t]!).toBeLessThanOrEqual(fa[t]! + 1e-9 * Math.max(1, fa[t]!));
				}
			}
		}
	});
});

describe('the invariants hold with both options on', () => {
	it('balance, workings, soil water, EWR attribution, order invariance and the crop-area property (random networks)', () => {
		let tested = 0;
		for (let seed = 1; seed < 400 && tested < 12; seed++) {
			const x = randomInput(seed, { maxDays: 200, allocationModes: false });
			if (!x.model.cropAreas.some((a) => a.areaM2 > 0)) continue;
			// Every crop on its own system, and a monthly fraction with a dry-season 0 and a wet-season 1.
			x.model.crops.forEach((c, i) => (c.irrigationEfficiency = [0.55, 0.7, 0.85, 0.95, 1][i % 5]));
			x.settings.effectiveRainFractionMonthly = [0.4, 0.5, 0.6, 1, 0.9, 0.8, 0.6, 0.5, 0.3, 0, 0.1, 0.2] as unknown as Monthly;
			tested++;
			expect(checkAll(x, seed), `seed ${seed}`).toBeNull();
		}
		expect(tested).toBe(12);
	});
});

describe('irrigation systems per crop and per unit (engine 1.72.0)', () => {
	const crop = (over: Partial<CropDef> = {}): CropDef => ({ id: 'a', name: 'Crop a', cropFactor: [...flat(1)], ...over });
	const one = (c: CropDef, area: Partial<CropArea> = {}, systems?: NonNullable<ModelInput['model']['irrigationSystems']>): ModelInput => {
		const x = input({ crops: [c], cropAreas: [{ nodeId: 'F', cropId: 'a', areaM2: 1000, ...area }], startDate: '2020-10-01', rain: [0] });
		if (systems) x.model.irrigationSystems = systems;
		return x;
	};

	it('runs a crop at its default system’s efficiency from the default table, and a unit’s own system over it', () => {
		// 100 m³/day of requirement: Flood / furrow (70 %) abstracts 100 / 0.7, Drip (90 %) 100 / 0.9.
		const flood = run(one(crop({ irrigationSystemId: 'surface' })));
		expect(get(flood, 'demand')[0]).toBeCloseTo(100 / 0.7, 9);
		const drip = run(one(crop({ irrigationSystemId: 'surface' }), { irrigationSystemId: 'drip' }));
		expect(get(drip, 'demand')[0]).toBeCloseTo(100 / 0.9, 9);
		expect(drip.summary.warnings.filter((w) => w.includes('irrigation system'))).toEqual([]);
		// The unit's 20 % return flow is more than drip's 10 % of losses: the run caps it there and says so.
		expect(drip.summary.warnings).toContain('unit "F": return flow 20 % of the water supplied is more than its losses at 90 % irrigation efficiency; using 10 %');
	});

	it('takes the project’s own table: a row’s efficiency moves every crop on it', () => {
		const table = [{ id: 's1', name: 'Our drip', efficiency: 0.95, preset: 'drip' as const }];
		expect(get(run(one(crop({ irrigationSystemId: 's1' }), {}, table)), 'demand')[0]).toBeCloseTo(100 / 0.95, 9);
	});

	it('the same crop on two units runs at each unit’s own system', () => {
		const x = input({
			crops: [crop({ irrigationSystemId: 'drip' })],
			cropAreas: [
				{ nodeId: 'F', cropId: 'a', areaM2: 1000 },
				{ nodeId: 'G', cropId: 'a', areaM2: 1000, irrigationSystemId: 'surface' }
			],
			startDate: '2020-10-01',
			rain: [0]
		});
		x.model.nodes.push(farm({ id: 'G', name: 'G', sortOrder: 1, downstreamNodeId: 'F' }));
		const out = run(x);
		expect(get(out, 'demand', 'F')[0]).toBeCloseTo(100 / 0.9, 9);
		expect(get(out, 'demand', 'G')[0]).toBeCloseTo(100 / 0.7, 9);
	});

	it('falls back to the crop’s legacy efficiency, then the unit’s, and warns once for a system the table lacks', () => {
		expect(get(run(one(crop({ irrigationEfficiency: 0.5 }))), 'demand')[0]).toBeCloseTo(200, 9);
		expect(get(run(one(crop())), 'demand')[0]).toBeCloseTo(125, 9); // the unit's 0.8
		const missing = run(one(crop({ irrigationSystemId: 'gone' })));
		expect(get(missing, 'demand')[0]).toBeCloseTo(125, 9);
		expect(missing.summary.warnings.filter((w) => w.includes('gone'))).toEqual(["crop \"Crop a\": irrigation system gone is not in the project's table; skipping it"]);
	});

	it('names every crop whose system the table lacks, whatever the units’ order (release soak, seeds 1087 and 1269)', () => {
		// Keyed by system alone the warning named whichever crop the run met first. Plantings are
		// sorted by unit then crop before they resolve, so only the unit order can change which comes
		// first: crop a on unit G, crop b on unit F, in both node orders.
		const both = (flip: boolean) => {
			const x = input({
				crops: [crop({ irrigationSystemId: 'gone' }), { ...crop({ irrigationSystemId: 'gone' }), id: 'b', name: 'Crop b', sortOrder: 1 }],
				cropAreas: [
					{ nodeId: 'G', cropId: 'a', areaM2: 1000 },
					{ nodeId: 'F', cropId: 'b', areaM2: 1000 }
				],
				startDate: '2020-10-01',
				rain: [0]
			});
			x.model.nodes.push(farm({ id: 'G', name: 'G', sortOrder: 1, downstreamNodeId: 'F' }));
			if (flip) x.model.nodes.reverse();
			return run(x).summary.warnings.filter((w) => w.includes('gone')).sort();
		};
		const expected = ['crop "Crop a": irrigation system gone is not in the project\'s table; skipping it', 'crop "Crop b": irrigation system gone is not in the project\'s table; skipping it'];
		expect(both(false)).toEqual(expected);
		expect(both(true)).toEqual(expected);
	});

	it('skips a unit’s system the table lacks for the crop’s default, then its legacy efficiency (fuzz seed 36, docs/model.md §2.3)', () => {
		// The planting's own system is missing: the crop's default (Flood / furrow, 70 %) runs, not the unit's 0.8.
		expect(get(run(one(crop({ irrigationSystemId: 'surface' }), { irrigationSystemId: 'gone' })), 'demand')[0]).toBeCloseTo(100 / 0.7, 9);
		// A legacy crop (engine ≤ 1.71.0) runs at its own 0.5 whether or not the run's upgrade has turned it into a table row first.
		const legacy = run(one(crop({ irrigationEfficiency: 0.5 }), { irrigationSystemId: 'gone' }));
		expect(get(legacy, 'demand')[0]).toBeCloseTo(200, 9);
		expect(legacy.summary.warnings.filter((w) => w.includes('gone'))).toEqual(["crop \"Crop a\": irrigation system gone is not in the project's table; skipping it"]);
	});
});
