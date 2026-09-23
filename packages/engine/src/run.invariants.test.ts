// Property-based checks of the engine: random valid inputs (./testing/fuzz.ts)
// must satisfy the physical invariants in ./testing/invariants.ts every day at
// every node. On a failure the seed and a shrunk reproduction are printed.
// Soak run (FUZZ_SEED picks the first seed):
//   FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/run.invariants.test.ts
import { describe, expect, it } from 'vitest';
import { calibrationStats } from './network/stats';
import { runModel } from './run';
import type { ModelInput } from './project';
import { randomInput, shrink } from './testing/fuzz';
import { checkAll, checkDoubledCropAreas, checkInvariants, checkOrderInvariance, checkTransferLimits } from './testing/invariants';

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

	it('F8 regression: the seeds where display order changed EWR "days not met" are order-invariant', () => {
		// Found by the order-invariance check: rounded engine (0.3.x) on 70 … 18130,
		// unrounded (0.4.0) on 103 … 395. Fixed in network/simulate.ts (review F8).
		for (const seed of [70, 599, 1648, 2685, 6655, 8046, 18130, 103, 125, 145, 148, 207, 232, 321, 342, 389, 395]) {
			const input = randomInput(seed);
			expect(checkOrderInvariance(input, runModel(input), seed), `seed ${seed}`).toBeNull();
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
		returnFlowPct: 0.1,
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
			transfers: [{ id: 't', fromNodeId: 'A', toNodeId: 'C', months: [1, 2], maxRateM3s: 0.005, dailyCapM3: null, minStoragePct: 0.25, enabled: true }]
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
		// Held back: the rule could move 432 but only 100 moved.
		const held = structuredClone(out);
		held.series.find((s) => s.nodeId === 'A' && s.key === 'transfer')!.values[0] = -100;
		held.series.find((s) => s.nodeId === 'C' && s.key === 'transfer')!.values[0] = 100;
		expect(checkTransferLimits(input, held)).toMatch(/sent only 100; the rules allowed 432/);
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

	it('order invariance and the crop-area property hold on the real model', () => {
		expect(checkOrderInvariance(input, out, 7)).toBeNull();
		expect(checkDoubledCropAreas(input, out)).toBeNull();
		// … and object when the "other" run differs.
		const shifted = structuredClone(out);
		shifted.summary.catchment.meanNaturalFlowM3Day += 1;
		expect(checkOrderInvariance(input, shifted, 7)).toMatch(/order invariance.*meanNaturalFlowM3Day/);
	});
});

// ---------------------------------------------------------------------------
// client catchment (client data, local only): the same invariants on the real
// catchment, through the full rain model. Skips only when data/ is absent.
// ---------------------------------------------------------------------------

type Fs = { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string };
const fsSpecifier = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsSpecifier)) as Fs;
const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? '.';
const dataDir = ['data/client-catchment', '../data/client-catchment', '../../data/client-catchment']
	.map((p) => `${cwd}/${p}`)
	.find((p) => fs.existsSync(`${p}/project.json`));

describe.skipIf(!dataDir)('engine invariants on client catchment (needs data/client-catchment)', () => {
	it('holds every invariant, including order invariance and the crop-area property', () => {
		const project = JSON.parse(fs.readFileSync(`${dataDir}/project.json`, 'utf8')) as {
			settings: ModelInput['settings'];
			model: ModelInput['model'];
			series: { kind: string; startDate: string; values: (number | null)[] }[];
		};
		const input: ModelInput = {
			settings: project.settings,
			model: project.model,
			series: Object.fromEntries(project.series.map((s) => [s.kind, { startDate: s.startDate, values: s.values }]))
		};
		for (const seed of [1, 2, 3]) expect(checkAll(input, seed)).toBeNull();
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
