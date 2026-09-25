// Property-based checks of the engine: random valid inputs (./testing/fuzz.ts)
// must satisfy the physical invariants in ./testing/invariants.ts every day at
// every node. On a failure the seed and a shrunk reproduction are printed.
// Soak run (FUZZ_SEED picks the first seed):
//   FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/run.invariants.test.ts
import { describe, expect, it } from 'vitest';
import { calibrationStats } from './network/stats';
import { runModel } from './run';
import { upgradeLegacyModel, type ModelInput } from './project';
import { randomInput, shrink } from './testing/fuzz';
import { checkAll, checkDoubledCropAreas, checkEwrAttribution, checkInvariants, checkOrderInvariance, checkTransferLimits, checkWorkings } from './testing/invariants';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.FUZZ_CASES ?? 400);
const SEED0 = Number(env.FUZZ_SEED ?? 1);
// ~25 ms per case (four model runs each); leave generous headroom for a soak.
const TIMEOUT = Math.max(120_000, CASES * 200);

/** The rule a failure message names, without node ids and day numbers, so shrinking keeps the same failure. */
const ruleOf = (msg: string) => msg.split(':')[0]!.replace(/n\d+ day \d+|day \d+|\(seed \d+[^)]*\)/g, '').trim();

describe('engine invariants on random networks', () => {
	it(`${CASES} random cases from seed ${SEED0}`, () => {
		const failures: string[] = [];
		for (let seed = SEED0; seed < SEED0 + CASES && failures.length < 3; seed++) {
			const input = randomInput(seed);
			const bad = checkAll(input, seed);
			if (!bad) continue;
			const rule = ruleOf(bad);
			const small = shrink(input, (x) => {
				const b = checkAll(x, seed);
				return b !== null && ruleOf(b) === rule;
			});
			failures.push(`seed ${seed}: ${bad}\n  shrunk: ${checkAll(small, seed)}\n  repro: ${JSON.stringify(small)}`);
		}
		expect(failures.join('\n\n')).toBe('');
	}, TIMEOUT);

	it(`${CASES} random cases from seed ${SEED0}, GR4J runoff`, () => {
		const failures: string[] = [];
		for (let seed = SEED0; seed < SEED0 + CASES && failures.length < 3; seed++) {
			const input = randomInput(seed, { runoffModel: 'gr4j' });
			const bad = checkAll(input, seed);
			if (!bad) continue;
			const rule = ruleOf(bad);
			const small = shrink(input, (x) => {
				const b = checkAll(x, seed);
				return b !== null && ruleOf(b) === rule;
			});
			failures.push(`seed ${seed}: ${bad}\n  shrunk: ${checkAll(small, seed)}\n  repro: ${JSON.stringify(small)}`);
		}
		expect(failures.join('\n\n')).toBe('');
	}, TIMEOUT);

	it('doubling crop areas can raise the supply fraction only through return flow (seed 25)', () => {
		// Why checkDoubledCropAreas zeroes the loss return fractions: with return
		// flow, extra draw on stored water partly returns to the river and a
		// starved farm downstream gains more than twice the water. That is
		// physics, not an engine bug (audit N1: bounded by G ≤ D).
		// (Seed 4660 showed it until engine 0.9.0 turned the upstream-to-dam
		// split round, model.md §3 Q1; 2538 until N1 and the soil-water store's
		// draws in the generator, then 2079 until dam evaporation (N2); 25 is
		// the first seed that shows it now.)
		const input = randomInput(25);
		input.settings.runoffModel = 'legacy'; // found under legacy flow; the property is the network's, not the runoff model's
		const frac = (x: ModelInput) => {
			const t = runModel(x).summary.farms.reduce((a, f) => [a[0]! + f.avgDemandM3Day, a[1]! + f.avgSuppliedM3Day], [0, 0]);
			return t[1]! / t[0]!;
		};
		const doubled = structuredClone(input);
		for (const a of doubled.model.cropAreas) a.areaM2 *= 2;
		expect(frac(doubled)).toBeGreaterThan(frac(input));
		expect(checkDoubledCropAreas(input)).toBeNull();
	});

	it('seed 921: doubling crop areas never raises the supply fraction of a leaking destination dam (engine 0.19.0)', () => {
		// A transfer's room at a destination whose dam seeps 100 % a day ignored
		// that seepage until 0.19.0, so the dam fell below its dead storage by a
		// fixed volume and the farm's supply fraction rose with its demand
		// (5.8 % → 7.3 % legacy, 7.5 % → 8.5 % GR4J; n13, 2 000-case soak on 0.17.0).
		for (const runoffModel of ['legacy', 'gr4j'] as const) {
			expect(checkDoubledCropAreas(randomInput(921, { runoffModel })), runoffModel).toBeNull();
			expect(checkAll(randomInput(921, { runoffModel }), 921), runoffModel).toBeNull();
		}
	});

	it('Q18: transfer rules sharing a dam give the same results in any list order (no exemption)', () => {
		// Seeds whose enabled rules share a source dam, with tied priorities among them.
		let tested = 0;
		for (let seed = 1; seed < 400 && tested < 10; seed++) {
			const input = randomInput(seed, { maxDays: 200 });
			const on = input.model.transfers.filter((t) => t.enabled);
			const shared = on.some((a, i) => on.some((b, j) => i !== j && a.fromNodeId === b.fromNodeId && a.priority === b.priority));
			if (!shared) continue;
			tested++;
			expect(checkOrderInvariance(input, runModel(input), seed), `seed ${seed}`).toBeNull();
		}
		expect(tested).toBeGreaterThan(0);
	});

	it('F8 regression: the seeds where display order changed EWR "days not met" are order-invariant', () => {
		// Found by the order-invariance check: rounded engine (0.3.x) on 70 … 18130,
		// unrounded (0.4.0) on 103 … 395. Fixed in network/simulate.ts (review F8).
		for (const seed of [70, 599, 1648, 2685, 6655, 8046, 18130, 103, 125, 145, 148, 207, 232, 321, 342, 389, 395]) {
			const input = randomInput(seed);
			expect(checkOrderInvariance(input, runModel(input), seed), `seed ${seed}`).toBeNull();
		}
	});

	it('engine 0.19.1–0.19.2: a float residue is not a farm\'s EWR impact, in any node order, and a tiny real one still is (seeds 4014, 8984, 9681; 9051, 11240, 15426)', () => {
		// A full dam spilling its runoff (e = I − spill, ±1e-11 at the storage's scale), and an
		// empty farm below one whose outflow carried a 1e-13 m³ residue, each passed a noise
		// test sized by their flows alone and were charged for a day in one node order and not
		// the other, so "days EWR not met" moved by one. Impacts are now judged against every
		// volume in the balance, dam storage and upstream flows included (network/attribution.ts).
		// 0.19.1 judged the storage and upstream terms at 1e-12 and zeroed real ~1e-6 m³ impacts
		// next to a 10⁶ m³ dam (the attribution self-check caught it, seeds 9051 … 15426); 0.19.2
		// uses ~45 ulp (RESIDUE) for those terms.
		for (const [seed, opts] of [[4014, {}], [8984, {}], [9681, { runoffModel: 'gr4j' as const }]] as const) {
			const input = randomInput(seed, opts);
			expect(checkOrderInvariance(input, runModel(input), seed), `seed ${seed}`).toBeNull();
		}
		for (const [seed, opts] of [[9051, {}], [11240, { runoffModel: 'gr4j' as const }], [15426, { runoffModel: 'gr4j' as const }]] as const) {
			const input = randomInput(seed, opts);
			expect(checkEwrAttribution(input, runModel(input)), `seed ${seed}`).toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------
// The invariants themselves must catch what they claim to: each is fed a
// deliberately broken output (or input) and has to object.
// ---------------------------------------------------------------------------

/** A small valid case with a dam, crops and one transfer that runs. */
function smallCase(): ModelInput {
	const node = (id: string, down: string | null, over: Partial<ModelInput['model']['nodes'][number]> = {}) => ({
		id,
		name: id,
		kind: 'farm' as const,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: 5,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0.5,
		pctRunoffToDam: 0.5,
		damCapacityM3: 50_000,
		damInitialPct: 0.8,
		damMinPct: 0,
		divertCapacityM3Day: 500,
		irrigationEfficiency: 0.8,
		lossReturnFraction: 0.5,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	});
	const days = 120;
	return {
		settings: { apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100], ewrPragmaticM3PerDay: new Array(12).fill(2000) as never },
		model: {
			nodes: [node('G', null, { kind: 'gauge', areaKm2: 0 }), node('A', 'B'), node('B', 'G', { sortOrder: 1 }), node('C', 'G', { sortOrder: 2, damCapacityM3: 0 })],
			crops: [{ id: 'c', name: 'Citrus', cropFactor: new Array(12).fill(0.7) }],
			cropAreas: [
				{ nodeId: 'B', cropId: 'c', areaM2: 300_000 },
				{ nodeId: 'C', cropId: 'c', areaM2: 200_000 }
			],
			transfers: [{ id: 't', fromNodeId: 'A', toNodeId: 'C', months: [1, 2], maxRateM3s: 0.005, dailyCapM3: null, minStoragePct: 0.25, enabled: true, priority: 0 }]
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: Array.from({ length: days }, (_, i) => (i % 9 === 0 ? 25 : 0)) } }
	};
}

describe('the invariants reject broken results', () => {
	const input = smallCase();
	const out = runModel(input);
	const edit = (key: string, nodeId: string | null, f: (v: number[]) => void) => {
		const o = structuredClone(out);
		f(o.series.find((s) => s.nodeId === nodeId && s.key === key)!.values);
		return o;
	};

	it('passes the real output, which moves water through the transfer', () => {
		expect(checkInvariants(input, out)).toBeNull();
		expect(out.series.find((s) => s.nodeId === 'C' && s.key === 'transfer')!.values.some((v) => v > 0)).toBe(true);
	});

	it('catches irrigation below the minimum operating level (Q5)', () => {
		// C alone, its dam draining to irrigation with no inflow; the run has no floor.
		const x = structuredClone(input);
		x.model.nodes = [{ ...x.model.nodes.find((n) => n.id === 'C')!, downstreamNodeId: null, damCapacityM3: 50_000, damInitialPct: 1, pctRunoffToDam: 0 }];
		x.model.transfers = [];
		x.model.cropAreas = x.model.cropAreas.filter((a) => a.nodeId === 'C');
		const o = runModel(x);
		expect(checkWorkings(x, o)).toBeNull();
		// Checked against a 99 % floor, C drew dead storage.
		x.model.nodes[0]!.damMinPct = 0.99;
		expect(checkWorkings(x, o)).toMatch(/supplied .* dead storage/);
	});

	it('catches dam evaporation, rain on the dam or seepage that does not follow the dam (N2)', () => {
		const x = structuredClone(input);
		const a = x.model.nodes.find((n) => n.id === 'A')!;
		a.damAreaFullM2 = 20_000;
		a.damSeepagePerDay = 0.001;
		const o = runModel(x);
		expect(checkInvariants(x, o)).toBeNull();
		expect(o.series.find((s) => s.nodeId === 'A' && s.key === 'dam_evaporation')!.values.some((v) => v > 0)).toBe(true);
		const bump = (key: string) => {
			const y = structuredClone(o);
			const s = y.series.find((z) => z.nodeId === 'A' && z.key === key)!;
			const t = s.values.findIndex((v) => v > 0);
			s.values[t] = s.values[t]! * 2;
			return y;
		};
		for (const key of ['dam_evaporation', 'rain_on_dam', 'dam_seepage']) expect(checkWorkings(x, bump(key)), key).toMatch(/rain on dam|evaporation|seepage|balance/);
		// A dam checked against a different area: the surface doesn't follow the storage.
		const smaller = structuredClone(x);
		smaller.model.nodes.find((n) => n.id === 'A')!.damAreaFullM2 = 10_000;
		expect(checkWorkings(smaller, o)).toMatch(/dam area/);
	});

	it('catches a broken farm balance, a negative storage and supply above demand', () => {
		expect(checkInvariants(input, edit('outflow', 'B', (v) => (v[3]! += 1)))).toMatch(/balance|routed/);
		expect(checkInvariants(input, edit('dam_storage', 'A', (v) => (v[0] = -1)))).toMatch(/storage|balance/);
		expect(checkInvariants(input, edit('supplied', 'B', (v) => (v[0] = 1e12)))).toMatch(/supplied|balance/);
	});

	it('catches transfers outside their months, above their limit, below the reserve, or held back', () => {
		// April is not a transfer month.
		const april = 31 + 28 + 31;
		const moved = (d: number) => edit('transfer', 'A', (v) => (v[april] = -d));
		expect(checkTransferLimits(input, (() => { const o = moved(10); o.series.find((s) => s.nodeId === 'C' && s.key === 'transfer')!.values[april] = 10; return o; })())).toMatch(/no rule active/);
		// Above the 432 m³/day rate limit on day 0.
		const over = structuredClone(out);
		over.series.find((s) => s.nodeId === 'A' && s.key === 'transfer')!.values[0] = -500;
		over.series.find((s) => s.nodeId === 'C' && s.key === 'transfer')!.values[0] = 500;
		expect(checkTransferLimits(input, over)).toMatch(/sent 500 > MIN\(limit 432/);
		// Held back: on a day the rule moved its full 432 (C's room, its demand, was larger) only 100 moved.
		const full = out.series.find((s) => s.nodeId === 'C' && s.key === 'transfer')!.values.findIndex((v) => Math.abs(v - 432) < 1e-9);
		expect(full).toBeGreaterThanOrEqual(0);
		const held = structuredClone(out);
		held.series.find((s) => s.nodeId === 'A' && s.key === 'transfer')!.values[full] = -100;
		held.series.find((s) => s.nodeId === 'C' && s.key === 'transfer')!.values[full] = 100;
		expect(checkTransferLimits(input, held)).toMatch(/sent only 100; the rules and the destinations' room allowed 432/);
		// Below the reserve: an almost empty source may not send anything.
		const low = structuredClone(input);
		low.model.nodes.find((n) => n.id === 'A')!.damInitialPct = 0.2; // 10 000 m³ < reserve 12 500
		const lowOut = runModel(low);
		expect(lowOut.series.find((s) => s.nodeId === 'A' && s.key === 'transfer')!.values[0]).toBe(0);
		const forced = structuredClone(lowOut);
		forced.series.find((s) => s.nodeId === 'A' && s.key === 'transfer')!.values[0] = -50;
		forced.series.find((s) => s.nodeId === 'C' && s.key === 'transfer')!.values[0] = 50;
		expect(checkTransferLimits(low, forced)).toMatch(/sent 50 > MIN\(limit 432, storage 10000 − reserve\) = 0/);
	});

	it('catches report totals that disagree with the daily series', () => {
		const grid = structuredClone(out);
		grid.summary.ewrCompliance!.outlet.shortfallM3[0]![3]! += 1000;
		expect(checkInvariants(input, grid)).toMatch(/EWR grid outlet/);
		const k = structuredClone(out);
		k.summary.curtailment!.farms[0]!.targetM3Day += 10;
		expect(checkInvariants(input, k)).toMatch(/curtailment/);
		const f = structuredClone(out);
		f.summary.farms[0]!.avgSuppliedM3Day += 1;
		expect(checkInvariants(input, f)).toMatch(/farm summary/);
	});

	it('catches a GR4J run whose natural flow, stores or summary break the runoff balance', () => {
		const g = structuredClone(input);
		g.settings.runoffModel = 'gr4j';
		const o = runModel(g);
		expect(checkInvariants(g, o)).toBeNull();
		expect(o.summary.runoff?.model).toBe('gr4j');
		const flow = structuredClone(o);
		flow.series.find((x) => x.nodeId === null && x.key === 'natural_flow')!.values[7]! += 1;
		expect(checkInvariants(g, flow)).toMatch(/runoff day 7: rain − AET − Q/);
		const store = structuredClone(o);
		store.series.find((x) => x.nodeId === null && x.key === 'routing_store')!.values[3]! -= 1e-6;
		expect(checkInvariants(g, store)).toMatch(/runoff day 3/);
		const summary = structuredClone(o);
		summary.summary.runoff!.aetMm += 0.01;
		expect(checkInvariants(g, summary)).toMatch(/runoff summary/);
		const missing = structuredClone(o);
		delete missing.summary.runoff;
		expect(checkInvariants(g, missing)).toMatch(/reported no water balance/);
	});

	it('order invariance and the crop-area property hold on the real model', () => {
		expect(checkOrderInvariance(input, out, 7)).toBeNull();
		expect(checkDoubledCropAreas(input)).toBeNull();
		// … and object when the "other" run differs.
		const shifted = structuredClone(out);
		shifted.summary.catchment.meanNaturalFlowM3Day += 1;
		expect(checkOrderInvariance(input, shifted, 7)).toMatch(/order invariance.*meanNaturalFlowM3Day/);
	});
});

// ---------------------------------------------------------------------------
// The client catchment (client data, local only): the same invariants on the real
// catchment, through the full rain model. Skips only when data/ is absent.
// ---------------------------------------------------------------------------

type Fs = { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string };
const fsSpecifier = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsSpecifier)) as Fs;
const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? '.';
const dataDir = ['data/client-catchment', '../data/client-catchment', '../../data/client-catchment']
	.map((p) => `${cwd}/${p}`)
	.find((p) => fs.existsSync(`${p}/project.json`));

describe.skipIf(!dataDir)('engine invariants on the client catchment (needs data/client-catchment)', () => {
	it('holds every invariant, including order invariance and the crop-area property', () => {
		const project = JSON.parse(fs.readFileSync(`${dataDir}/project.json`, 'utf8')) as {
			settings: ModelInput['settings'];
			model: ModelInput['model'];
			series: { kind: string; startDate: string; values: (number | null)[] }[];
		};
		// As migration 006 stores an extracted project: return flow % → irrigation efficiency, dam minimum → 0.
		const model = upgradeLegacyModel(project.model);
		for (const n of model.nodes) n.damMinPct = 0;
		const input: ModelInput = {
			settings: project.settings,
			model,
			series: Object.fromEntries(project.series.map((s) => [s.kind, { startDate: s.startDate, values: s.values }]))
		};
		for (const seed of [1, 2, 3]) expect(checkAll(input, seed)).toBeNull();
		const gr4j = { ...input, settings: { ...input.settings, runoffModel: 'gr4j' as const } };
		expect(checkAll(gr4j, 1)).toBeNull();
	}, 60_000);
});

describe('calibration statistic identities', () => {
	it('NSE, PBIAS, KGE of a perfect fit and NSE of the mean', () => {
		for (let seed = 1; seed <= 50; seed++) {
			const obs = randomInput(seed).series.flow_observed_m3s?.values ?? [1, 2, 3, null, 5];
			const vals = obs.filter((v): v is number => v !== null);
			if (vals.length < 2 || new Set(vals).size < 2) continue;
			const perfect = calibrationStats(obs.map((o) => (o ?? 0) * 86_400), obs);
			expect(perfect.nse).toBeCloseTo(1, 9);
			expect(perfect.pbias).toBeCloseTo(0, 9);
			expect(perfect.kge).toBeCloseTo(1, 9);
			const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
			expect(calibrationStats(obs.map(() => mean * 86_400), obs).nse).toBeCloseTo(0, 9);
		}
	});
});
