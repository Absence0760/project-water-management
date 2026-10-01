// Property-based checks of the engine: random valid inputs (./testing/fuzz.ts)
// must satisfy the physical invariants in ./testing/invariants.ts every day at
// every node. This file holds the pinned regression seeds; the random soak is
// sharded across ./fuzz/*.test.ts so it runs on several cores. Soak run
// (FUZZ_SEED picks the first seed; FUZZ_MAX_FAILURES=100 lists every failure):
//   FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/fuzz
import { describe, expect, it } from 'vitest';
import { calibrationStats } from './network/stats';
import { runModel } from './run';
import { OPERATING_DEFAULTS, upgradeLegacyModel, type ModelInput } from './project';
import { randomInput, Rng } from './testing/fuzz';
import { hasMonthlyRates, transferRatesM3s, withMonthlyRates } from './network/transferRates';
import { checkAll, checkDoubledCropAreas, droughtBoreholesAsSupplemental, checkEwrAttribution, checkInvariants, checkOrderInvariance, checkReliability, checkTransferLimits, checkWaterAccount, checkWorkings } from './testing/invariants';
import { clientCatchmentDirs } from './testing/client-catchment-fixture';

describe('engine invariants on random networks', () => {
	// The random soak itself (checkAll on FUZZ_CASES seeds, GR4J) is
	// sharded across src/fuzz/*.test.ts so it runs on several cores; the pinned
	// regression seeds stay here.

	it('doubling crop areas can raise the supply fraction only through return flow (seed 25)', () => {
		// Why checkDoubledCropAreas zeroes the loss return fractions: with return
		// flow, extra draw on stored water partly returns to the river and a
		// starved farm downstream gains more than twice the water. That is
		// physics, not an engine bug (audit N1: bounded by G ≤ D).
		// (Seed 4660 showed it until engine 0.9.0 turned the upstream-to-dam
		// split round, model.md §3 Q1; 2538 until N1 and the soil-water store's
		// draws in the generator, then 2079 until dam evaporation (N2); 25 is
		// the first seed that shows it now.)
		// The property is the network's, not the runoff model's: it was found under the legacy model's flow (removed in engine 1.0.0).
		// Engine 1.32.0's generator gives seed 25 hands-off flows and River to dam by month (from their
		// own stream, the rest of the seed unchanged); they are taken off so it still shows the property.
		const input = randomInput(25);
		for (const n of input.model.nodes) Object.assign(n, OPERATING_DEFAULTS);
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
		expect(checkDoubledCropAreas(randomInput(921))).toBeNull();
		expect(checkAll(randomInput(921), 921)).toBeNull();
	});

	it('engine 1.24.0: a supplemental dam-target top-up supplies the demand exactly, not an ulp of the dam short (seeds 1774, 11421)', () => {
		// n14's dam seeps all it holds every day and a supplemental dam-target borehole (1e9 m³/day, its cap
		// taken off by droughtBoreholesAsSupplemental) refills it to dead storage + demand. Until 1.24.0 the
		// dam then gave back the demand only to an ulp of its volume: seed 1774 (2.19e5 m³, 2 000-case soak on
		// 1.3.0) left the supply fraction 0.9999999999964 → 0.9999999999984 when the demand doubled, and seed
		// 11421 (1.43e6 m³, 20 000-case soak on 1.20.0, #164) left 1e-10 m³ of a 0.011 m³ demand unmet, a day
		// time reliability counted as failed, and more days of it in the base run than the doubled one
		// (0.98343 → 0.98481). A unit that pumped all it was asked for now leaves the dam supplying `rem`
		// itself (network/boreholes.ts groundwaterDay), so a top-up day is short by no more than an ulp of its demand.
		for (const [seed, id] of [[1774, 'n14'], [11421, 'n14']] as const) {
			const input = droughtBoreholesAsSupplemental(randomInput(seed));
			expect(input.model.boreholes!.some((b) => b.nodeId === id && b.mode === 'supplemental' && b.target === 'dam'), `seed ${seed}`).toBe(true);
			const base = structuredClone(input);
			for (const n of base.model.nodes) n.lossReturnFraction = 0;
			const doubled = structuredClone(base);
			for (const a of doubled.model.cropAreas) a.areaM2 *= 2;
			for (const x of [base, doubled]) {
				const out = runModel(x);
				const d = out.series.find((s) => s.nodeId === id && s.key === 'demand')!.values;
				const g = out.series.find((s) => s.nodeId === id && s.key === 'supplied')!.values;
				const gd = out.series.find((s) => s.nodeId === id && s.key === 'groundwater_to_dam')!.values;
				let topUps = 0;
				for (let t = 0; t < d.length; t++) {
					if (!(gd[t]! > 0 && d[t]! > 0)) continue;
					topUps++;
					// What's left is the demand's own rounding (GWp + (D − GWp)), an ulp of D, not of the dam.
					expect(d[t]! - g[t]!, `seed ${seed} day ${t}: ${g[t]} of ${d[t]}`).toBeLessThanOrEqual(4 * Number.EPSILON * d[t]!);
				}
				expect(topUps, `seed ${seed}`).toBeGreaterThan(0);
			}
			expect(checkDoubledCropAreas(input), `seed ${seed}`).toBeNull();
			expect(checkAll(input, seed), `seed ${seed}`).toBeNull();
		}
	});

	it('engine 1.24.0: a unit with river off-take water is never supplied an ulp above its demand (seed 15467)', () => {
		// n7's supply was Xused + MIN(the rest, D − Xused), which rounds one ulp above D: 3439.3663942672592 >
		// 3439.366394267259 on day 0, a curtailment row supplied above its demand (20 000-case soak on 1.20.0, #164).
		const input = randomInput(15467);
		const out = runModel(input);
		expect(out.series.some((s) => s.key === 'offtake_in' && s.nodeId === 'n7' && s.values.some((v) => v > 0))).toBe(true);
		const get = new Map(out.series.map((s) => [`${s.nodeId}|${s.key}`, s.values]));
		for (const n of input.model.nodes) {
			const d = get.get(`${n.id}|demand`);
			const g = get.get(`${n.id}|supplied`);
			if (d && g) for (let t = 0; t < d.length; t++) expect(g[t]! <= d[t]!, `${n.id} day ${t}: ${g[t]} > ${d[t]}`).toBe(true);
		}
		expect(checkAll(input, 15467)).toBeNull();
	});

	it('seed 10306: the depletion infeed worked back from a 6e9 m³ deficit is judged at that scale (checkGroundwater)', () => {
		// u1's boreholes have two depletion factors, so checkGroundwater works each day's infeed back from the
		// lag store and the carried deficit. With 6.18e9 m³ owed (ulp 9.5e-7) that left 1.1e-6 m³ of infeed on
		// a day nothing was pumped, outside a tolerance sized without the deficit (20 000-case soak on 1.20.0,
		// #164). A check harness change, no engine change; the store identity is still checked day by day.
		const input = randomInput(10306);
		const out = runModel(input);
		const owed = out.series.find((s) => s.nodeId === 'u1' && s.key === 'depletion_deficit')!.values;
		expect(Math.max(...owed)).toBeGreaterThan(1e9);
		expect(checkInvariants(input, out)).toBeNull();
		expect(checkAll(input, 10306)).toBeNull();
	});

	it('engine 0.21.1: doubling crop areas never raises the supply fraction below a steep, shallow dam (seeds 4197, 7686, 15979, 17277)', () => {
		// Each had a dam with b > 1 (3, 2.34, 3, 3) and a mean depth of 0.5–32 mm, so a day's
		// evaporation took more than 1/b of it. The daily step then turned order round: the
		// doubled run's lower dam, with a smaller surface, kept water the base run's fuller dam
		// lost entirely (seed 15979: 149 m³ all evaporated, 144 m³ kept 3 m³), and the farm's
		// supply fraction rose 0.838 → 0.870. Evaporation is now capped at (1 − seepage) × Q[t−1] / b
		// for b > 1 (network/simulate.ts damDay); the check itself is unchanged.
		// (7686 and 15979 were found under the legacy model's flow, removed in engine 1.0.0; they now run GR4J.)
		// Engine 1.32.0's generator gives some of these seeds hands-off flows and River to dam by month (4197
		// and 15979 among them); they are taken off, as for seed 25, so the shallow dam still fills and empties
		// as it did and the evaporation limiter is still exercised.
		for (const seed of [4197, 7686, 15979, 17277]) {
			const input = randomInput(seed);
			for (const n of input.model.nodes) Object.assign(n, OPERATING_DEFAULTS);
			expect(checkDoubledCropAreas(input), `seed ${seed}`).toBeNull();
			expect(checkAll(input, seed), `seed ${seed}`).toBeNull();
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

	it('engine 1.36.0: several rules from one dam, at mixed reserves and rates (some 0), never take it below a rule\'s own reserve, in any list order', () => {
		// The random networks rarely put three rules on one dam at one priority, which the old
		// shared-free-water bug needed; these do on purpose. checkAll includes checkTransferLimits
		// (its per-rule reserve check) and order invariance.
		let tested = 0;
		for (let seed = 1; seed <= 400 && tested < 120; seed++) {
			const input = randomInput(seed, { maxDays: 120 });
			const farms = input.model.nodes.filter((n) => n.kind === 'farm');
			const src = farms.find((n) => n.damCapacityM3 > 0);
			if (!src || farms.length < 3) continue;
			const g = new Rng(seed * 7919);
			src.damInitialPct = g.pick([1, 0.9, 0.6, 0.4]);
			const others = farms.filter((n) => n !== src);
			input.model.transfers = Array.from({ length: g.int(3, 5) }, (_, k) => ({
				id: `r${k}`,
				fromNodeId: src.id,
				toNodeId: g.pick(others).id,
				months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
				maxRateM3s: g.pick([0, g.logFloat(1e-4, 0.05), g.logFloat(0.01, 2)]),
				dailyCapM3: null,
				minStoragePct: g.pick([0, 0.2, 0.5, 0.5, 0.8]),
				enabled: true,
				priority: g.pick([0, 0, 0, 1])
			}));
			tested++;
			expect(checkAll(input, seed), `seed ${seed}`).toBeNull();
		}
		expect(tested).toBeGreaterThan(50);
	});

	it('monthly rates (engine 1.14.0): writing every rule as its one rate in its months, month by month, changes nothing to the bit', () => {
		let tested = 0;
		for (let seed = 1; seed < 300 && tested < 12; seed++) {
			const input = randomInput(seed, { maxDays: 150 });
			if (!input.model.transfers.some((t) => t.enabled && !hasMonthlyRates(t) && t.months.length)) continue;
			tested++;
			const monthly = structuredClone(input);
			// A listed month with max rate 0 runs and moves nothing, which a monthly 0 (off) matches in volume;
			// rules at rate 0 are left as they are, since "on, moving nothing" can still share a dam's free water (Q18).
			for (const t of monthly.model.transfers) if (!hasMonthlyRates(t) && t.maxRateM3s > 0) Object.assign(t, withMonthlyRates(transferRatesM3s(t)));
			const a = runModel(input);
			const b = runModel(monthly);
			expect(b.series, `seed ${seed}`).toEqual(a.series);
		}
		expect(tested).toBeGreaterThan(5);
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
		// uses ~45 ulp (RESIDUE) for those terms. (Seeds without an option were found under the legacy
		// model's flow, removed in engine 1.0.0; every seed runs GR4J now.)
		for (const [seed, opts] of [[4014, {}], [8984, {}], [9681, {}]] as const) {
			const input = randomInput(seed, opts);
			expect(checkOrderInvariance(input, runModel(input), seed), `seed ${seed}`).toBeNull();
		}
		// 0.21.1: a transfer source at its reserve sends a one-ulp residue in one node order (seed 14313).
		// 0.24.1: Reserve rule tables. Two tables for one site were resolved by list order, and a site's
		// natural flow summed in display order moved the percentile across a flat stretch of the curve.
		for (const [seed, opts] of [[3238, {}], [6191, {}], [17126, {}], [18472, {}]] as const) {
			const input = randomInput(seed, opts);
			expect(checkOrderInvariance(input, runModel(input), seed), `seed ${seed}`).toBeNull();
		}
		expect(checkOrderInvariance(randomInput(14313), runModel(randomInput(14313)), 14313), 'seed 14313').toBeNull();
		for (const [seed, opts] of [[9051, {}], [11240, {}], [15426, {}]] as const) {
			const input = randomInput(seed, opts);
			expect(checkEwrAttribution(input, runModel(input)), `seed ${seed}`).toBeNull();
		}
	});

	it('engine 0.26.1: list-order float sums no longer tip a dam at its drought trigger or at empty (the first human-impact soak)', () => {
		// The first 20 000-case soak with other water users, boreholes and land cover
		// failed order invariance with real differences: sums over the nodes (flow
		// shares, the catchment area), crops, crop areas, senior claims, land-cover
		// patches and transfers ran in list order, their last bit followed the
		// display order, and a threshold made it a result. Seed 3899: a dam sat
		// exactly at its drought trigger, 481.22408531730883 vs …088 m³, so its
		// boreholes pumped 116 938 m³ in one order and nothing in the other; 7094:
		// the catchment area, and so every natural flow, differed in the last bit;
		// 5703, 15208: a dam ran dry in one order and kept a residue with a surface
		// in the other; 17355: an other user's EWR days not met, 209 vs 210.
		for (const seed of [3899, 5703, 6326, 7077, 7094, 7599, 10525, 15208, 17002, 17355, 19035]) {
			const input = randomInput(seed);
			expect(checkOrderInvariance(input, runModel(input), seed), `seed ${seed}`).toBeNull();
		}
		for (const seed of [3321, 4260, 9912, 18288, 18330, 19214, 3899, 7094]) {
			const input = randomInput(seed);
			expect(checkOrderInvariance(input, runModel(input), seed), `seed ${seed}, GR4J`).toBeNull();
		}
	});

	it('engine 1.55.0: the validation signatures stay in range and only report (CR-16, model.md §2.10d)', () => {
		const inRange = (v: number) => v >= 0 && v <= 1;
		let seen = 0;
		for (let seed = 1; seed <= 60 && seen < 8; seed++) {
			const input = randomInput(seed);
			const out = runModel(input);
			const sig = out.summary.plausibility?.signatures;
			if (!sig) continue;
			const bf = sig.baseflow;
			if (bf) {
				seen++;
				expect(bf.days).toBeGreaterThanOrEqual(365);
				expect(bf.days).toBeLessThanOrEqual(out.days);
				for (const p of [bf.hughes, bf.eckhardt]) {
					if (!p) continue;
					// A BFI is a share of the flow: base flow never exceeds flow on any day.
					expect(inRange(p.observed) && inRange(p.simulated), `seed ${seed}`).toBe(true);
					expect(p.difference).toBe(p.simulated - p.observed);
				}
			}
			const fdc = sig.lowFlowFdc;
			if (fdc) {
				expect(fdc.days).toBeLessThanOrEqual(out.days);
				// Q70 is at least Q95 on any duration curve, so neither slope is negative.
				expect(fdc.observedQ70M3s).toBeGreaterThanOrEqual(fdc.observedQ95M3s);
				expect(fdc.simulatedQ70M3s).toBeGreaterThanOrEqual(fdc.simulatedQ95M3s);
				expect(Math.min(fdc.observedSlope, fdc.simulatedSlope)).toBeGreaterThanOrEqual(0);
			}
			const h = sig.recessionHoldout;
			if (h) {
				expect(h.heldOut.length).toBe(Math.floor(h.segments / h.every));
				for (const [a, b] of h.heldOut) expect(0 <= a && a < b && b < out.days).toBe(true);
				expect(h.modelSegments).toBeLessThanOrEqual(h.heldOut.length);
				expect(h.modelDays).toBeLessThanOrEqual(h.days);
				// A skill against no recession is at most 1 (a perfect fall).
				for (const v of [h.modelSkill, h.lawSkill]) if (v !== null) expect(v).toBeLessThanOrEqual(1);
			}
			// Only a report: without the observed records the flows are the same to the bit.
			if (seed % 4 === 0) {
				const bare = structuredClone(input);
				delete bare.series.flow_observed_m3s;
				delete bare.series.flow_logger_m3s;
				const flow = (o: typeof out) => o.series.find((x) => x.nodeId === null && x.key === 'simulated_outflow')?.values;
				expect(flow(runModel(bare)), `seed ${seed}`).toEqual(flow(out));
			}
		}
		expect(seen).toBe(8);
	});

	it('engine 0.32.0: the water account closes in a dry year of a long run (seed 1486)', () => {
		// Summed from prefix sums over the run, a 5 m³ year carried the whole
		// run's rounding: a residual of 3e-9 m³ (network/reliability.ts dailyTotals).
		const input = randomInput(1486);
		const out = runModel(input);
		expect(checkWaterAccount(out)).toBeNull();
		expect(checkReliability(out)).toBeNull();
		expect(checkAll(input, 1486)).toBeNull();
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
		expect(checkInvariants(g, missing)).toMatch(/reported its stores but no water balance/);
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
const dataDir = clientCatchmentDirs().find((p) => fs.existsSync(`${p}/project.json`));

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
