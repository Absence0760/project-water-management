// Deep end-to-end pass on allocations (docs/model.md §2.12, §2.12a) over
// seeded random networks (testing/fuzz.ts: dams, boreholes with dam-target
// units, river pumps, off-takes, river abstractions, water users, restrictions,
// development) with registered volumes of our own: validity windows, both
// sources, storage-only 21b rows, licence months and rates. Each property is
// re-derived from model.md, never from the engine's code:
//   cap            — a water year's surface use (supplied − groundwater_used)
//                    and groundwater use (groundwater_used + groundwater_to_dam)
//                    never exceed the whole year's budget; the stored room is
//                    MIN(MAX(0, budget − use so far), the licence limit) and
//                    each day's use stays within it; a day with none of the
//                    source's allocations in force isn't capped (engine ≥
//                    1.70.0, #90 Q24): its room is blank, its use doesn't
//                    count, and a year without a capped day is in neither
//                    capReached nor limitBound;
//   fullAllocation — the factor is constant within a water year, and a year
//                    with demand asks for exactly the volume registered over
//                    its run days (both sources); a year with none in force
//                    on those days keeps its demand, factor 1 (engine ≥ 1.70.0);
//   every mode     — RunSummary.allocations equals compareAllocations on the
//                    run's own stored series, selected with the backend's own
//                    key set (backend/src/allocations/runUse.ts, read here);
//                    the groundwater side equals RunSummary.groundwaterAnnualUse.
// Synthetic values only.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareAllocations, type AllocationEntry, type AllocationUseNode } from '../allocations/compare';
import { usableAllocations } from '../allocations/mode';
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearOf } from '../calendar';
import type { ModelInput, ModelOutput } from '../project';
import { Rng } from '../random';
import { runModel, runModelCapturing, runModelFrom } from '../run';
import { cloneInput, randomInput } from '../testing/fuzz';

const wyStart = (wy: number) => toEpochDay(`${wy}-10-01`);
const yearDays = (wy: number) => wyStart(wy + 1) - wyStart(wy);

/** Our own registered volumes on the farms and users of a random network. */
function withAllocations(input: ModelInput, seed: number, mode: 'none' | 'cap' | 'fullAllocation'): ModelInput {
	const x = cloneInput(input);
	const g = new Rng(seed ^ 0x2f6b9a13);
	const start = toEpochDay(Object.values(x.series).find((s) => s)!.startDate);
	const date = (lo: number, hi: number) => fromEpochDay(start + g.int(lo, hi));
	const out: AllocationEntry[] = [];
	for (const n of x.model.nodes) {
		if (n.kind === 'gauge' || !g.bool(0.75)) continue;
		for (let k = 0, count = g.int(1, 3); k < count; k++) {
			let validFrom = g.bool(0.6) ? null : date(-200, 900);
			let validTo = g.bool(0.6) ? null : date(-200, 900);
			if (validFrom && validTo && validFrom > validTo) [validFrom, validTo] = [validTo, validFrom];
			const a: AllocationEntry = {
				id: `al-${n.id}-${k}`,
				nodeId: n.id,
				waterSource: g.pick(['surface', 'surface', 'groundwater'] as const),
				volumeM3PerYear: g.pick([0, g.logFloat(10, 1e4), g.logFloat(1e3, 1e6), g.logFloat(1e5, 1e8)]),
				validFrom,
				validTo
			};
			if (g.bool(0.1)) Object.assign(a, { waterUse: '21b', volumeM3PerYear: 0, storageM3: g.logFloat(100, 1e6) });
			if (g.bool(0.3)) a.months = g.pick([[10, 11, 12, 1, 2, 3], [4, 5, 6, 7, 8, 9], [g.int(1, 12)]]);
			if (g.bool(0.3)) a.maxRateM3s = g.pick([0, g.logFloat(1e-4, 0.1), 100]);
			out.push(a);
		}
	}
	x.model.allocations = out;
	x.settings = { ...x.settings, allocationMode: mode };
	return x;
}

const series = (out: ModelOutput, nodeId: string, key: string) => out.series.find((s) => s.nodeId === nodeId && s.key === key)?.values ?? null;
const zeros = (n: number) => new Array<number>(n).fill(0);

/** The run's water years as [first day, last day] run indices. */
function spans(out: ModelOutput): { wy: number; from: number; to: number }[] {
	const d0 = toEpochDay(out.startDate);
	const res: { wy: number; from: number; to: number }[] = [];
	for (let t = 0; t < out.days; t++) {
		const wy = waterYearOf(d0 + t);
		const last = res.at(-1);
		if (last && last.wy === wy) last.to = t;
		else res.push({ wy, from: t, to: t });
	}
	return res;
}

/** §2.12a budget: Σ V × |whole year ∩ validity| ÷ |L(y)| over the unit's take allocations of one source. */
function budget(allocs: readonly AllocationEntry[], wy: number): number {
	let sum = 0;
	for (const a of allocs) {
		const lo = Math.max(wyStart(wy), a.validFrom ? toEpochDay(a.validFrom) : -Infinity);
		const hi = Math.min(wyStart(wy + 1) - 1, a.validTo ? toEpochDay(a.validTo) : Infinity);
		if (hi >= lo) sum += (a.volumeM3PerYear * (hi - lo + 1)) / yearDays(wy);
	}
	return sum;
}
/** Whether any of the allocations is in force on epoch day d (§2.12a, engine ≥ 1.70.0: a day none is isn't capped). */
const inForceOn = (allocs: readonly AllocationEntry[], d: number) => allocs.some((a) => !((a.validFrom && d < toEpochDay(a.validFrom)) || (a.validTo && d > toEpochDay(a.validTo))));
/** §2.12a licence limit on epoch day d: Σ rate × 86 400 over the in-force allocations whose months include d's; none in force or none stated = ∞. */
function limit(allocs: readonly AllocationEntry[], d: number): number {
	if (!allocs.some((a) => (a.months != null && a.months.length > 0) || a.maxRateM3s != null)) return Infinity;
	const m = monthOfEpochDay(d);
	let inForce = false;
	let v = 0;
	for (const a of allocs) {
		if ((a.validFrom && d < toEpochDay(a.validFrom)) || (a.validTo && d > toEpochDay(a.validTo))) continue;
		inForce = true;
		if (!a.months?.length || a.months.includes(m)) v += a.maxRateM3s == null ? Infinity : a.maxRateM3s * 86400;
	}
	return inForce ? v : Infinity;
}
const takes = (input: ModelInput, nodeId: string, source: 'surface' | 'groundwater') =>
	(input.model.allocations ?? []).filter((a) => a.nodeId === nodeId && a.waterSource === source && a.waterUse !== '21b');

const SEEDS = Array.from({ length: 90 }, (_, k) => 4200 + k * 13);
const GEN = { maxNodes: 9, maxDays: 800 };

describe('deep: an allocation cap holds a year’s use to its whole-year budget (§2.12a)', () => {
	it('surface and groundwater, every unit, every water year; the room column and each day’s use replayed', () => {
		let bound = 0;
		let uncapped = 0;
		const kinds = { volumeDays: 0, rateDays: 0, monthsDays: 0 };
		const bad: string[] = [];
		for (const seed of SEEDS) {
			const input = withAllocations(randomInput(seed, GEN), seed, 'cap');
			const out = runModel(input);
			const d0 = toEpochDay(out.startDate);
			for (const n of input.model.nodes) {
				if (n.kind !== 'farm' && n.kind !== 'user') continue;
				const sup = series(out, n.id, 'supplied');
				if (!sup) continue;
				const gw = series(out, n.id, 'groundwater_used') ?? zeros(out.days);
				const gd = series(out, n.id, 'groundwater_to_dam') ?? zeros(out.days);
				for (const source of ['surface', 'groundwater'] as const) {
					const own = takes(input, n.id, source);
					const room = series(out, n.id, `allocation_room_${source}`);
					if (!own.length) {
						if (room) bad.push(`seed ${seed} ${n.id}: a ${source} room without a ${source} allocation`);
						continue;
					}
					if (!room) {
						bad.push(`seed ${seed} ${n.id}: no ${source} room column`);
						continue;
					}
					for (const s of spans(out)) {
						const b = budget(own, s.wy);
						let used = 0;
						for (let t = s.from; t <= s.to; t++) {
							if (!inForceOn(own, d0 + t)) {
								uncapped++;
								if (!Number.isNaN(room[t]!)) bad.push(`seed ${seed} ${n.id} ${source} ${fromEpochDay(d0 + t)}: room ${room[t]} on an uncapped day, not blank`);
								continue;
							}
							const use = source === 'surface' ? sup[t]! - gw[t]! : gw[t]! + gd[t]!;
							const want = Math.min(Math.max(0, b - used), limit(own, d0 + t));
							const tol = 1e-9 * Math.max(1, b, Number.isFinite(want) ? want : 0);
							if (Math.abs(room[t]! - want) > tol && !(room[t] === want)) bad.push(`seed ${seed} ${n.id} ${source} ${fromEpochDay(d0 + t)}: room ${room[t]} ≠ ${want}`);
							if (use > room[t]! + tol) bad.push(`seed ${seed} ${n.id} ${source} ${fromEpochDay(d0 + t)}: used ${use} > room ${room[t]}`);
							used += use;
						}
						if (used > b + 1e-9 * Math.max(1, b)) bad.push(`seed ${seed} ${n.id} ${source} ${s.wy}: ${used} m³ > budget ${b}`);
						if (b > 0 && used >= b * (1 - 1e-9)) bound++;
					}
					// RunSummary: capReached (use within 10⁻⁹ of the budget) and limitBound (days the room was all taken
					// and the unit still went short, split by which limit set the room), replayed from the series.
					const src = out.summary.allocations!.nodes.find((x) => x.nodeId === n.id)!.sources.find((x) => x.waterSource === source)!;
					const reached: number[] = [];
					const lb: { waterYear: number; days: number; volumeDays: number; rateDays: number; monthsDays: number }[] = [];
					const dem = series(out, n.id, 'demand')!;
					const def = series(out, n.id, 'deficit')!;
					const statesMonths = own.some((a) => a.months != null && a.months.length > 0);
					for (const s of spans(out)) {
						const b = budget(own, s.wy);
						let used = 0;
						let capped = false;
						const y = { waterYear: s.wy, days: 0, volumeDays: 0, rateDays: 0, monthsDays: 0 };
						for (let t = s.from; t <= s.to; t++) {
							if (!inForceOn(own, d0 + t)) continue;
							capped = true;
							const use = source === 'surface' ? sup[t]! - gw[t]! : gw[t]! + gd[t]!;
							const left = Math.max(0, b - used);
							const lim = limit(own, d0 + t);
							const room = Math.min(left, lim);
							if (def[t]! > 1e-9 * Math.max(dem[t]!, 1) && use >= room - 1e-9 * Math.max(room, 1)) {
								const inForce = own.filter((a) => !((a.validFrom && d0 + t < toEpochDay(a.validFrom)) || (a.validTo && d0 + t > toEpochDay(a.validTo))));
								const outside = statesMonths && inForce.length > 0 && !inForce.some((a) => !a.months?.length || a.months.includes(monthOfEpochDay(d0 + t)));
								const kind = left <= lim + 1e-9 * Math.max(b, 1) ? 'volumeDays' : outside ? 'monthsDays' : 'rateDays';
								y.days++;
								y[kind]++;
								kinds[kind]++;
							}
							used += use;
						}
						if (capped && used >= b * (1 - 1e-9)) reached.push(s.wy);
						if (y.days) lb.push(y);
					}
					const got = (src.capReached ?? []).map((r) => r.waterYear);
					if (JSON.stringify(got) !== JSON.stringify(reached)) bad.push(`seed ${seed} ${n.id} ${source}: capReached ${JSON.stringify(got)} ≠ ${JSON.stringify(reached)}`);
					if (JSON.stringify(src.limitBound ?? []) !== JSON.stringify(lb)) bad.push(`seed ${seed} ${n.id} ${source}: limitBound ${JSON.stringify(src.limitBound)} ≠ ${JSON.stringify(lb)}`);
				}
			}
			if (bad.length > 8) break;
		}
		expect(bad).toEqual([]);
		// The cap binds in enough years for this to test something (15 on these seeds since 1.70.0, which no longer
		// counts the use before a licence's start against its first year).
		expect(bound).toBeGreaterThan(10);
		// Some days have none of a unit's allocations of a source in force, so the uncapped rule is reached.
		expect(uncapped).toBeGreaterThan(100);
		// Each kind of limit binds somewhere, so the limitBound replay isn't vacuous.
		expect(kinds.volumeDays).toBeGreaterThan(0);
		expect(kinds.rateDays).toBeGreaterThan(0);
		expect(kinds.monthsDays).toBeGreaterThan(0);
	});
});

describe('deep: a full-allocation run (§2.12a)', () => {
	it('the factor is constant within each water year, and a year with demand asks for exactly its registered volume over its run days', () => {
		const bad: string[] = [];
		let scaled = 0;
		let unlicensed = 0;
		for (const seed of SEEDS) {
			const input = withAllocations(randomInput(seed, GEN), seed, 'fullAllocation');
			const out = runModel(input);
			const d0 = toEpochDay(out.startDate);
			for (const n of input.model.nodes) {
				if (n.kind !== 'farm' && n.kind !== 'user') continue;
				const own = (input.model.allocations ?? []).filter((a) => a.nodeId === n.id && a.waterUse !== '21b');
				const k = series(out, n.id, 'allocation_demand_factor');
				if (!own.length) {
					if (k) bad.push(`seed ${seed} ${n.id}: a factor without an allocation`);
					continue;
				}
				if (!k) {
					bad.push(`seed ${seed} ${n.id}: no factor column`);
					continue;
				}
				const D = series(out, n.id, 'demand')!;
				const from = n.abstractionFrom ? toEpochDay(n.abstractionFrom) : -Infinity;
				for (const s of spans(out)) {
					for (let t = s.from; t <= s.to; t++) if (k[t] !== k[s.from]) bad.push(`seed ${seed} ${n.id} ${s.wy}: factor ${k[t]} on ${fromEpochDay(d0 + t)} ≠ ${k[s.from]}`);
					// The year a forecast tail starts in is fitted on its historical days (engine ≥ 1.28.0, §2.4f).
					const hist = out.summary.historyDays ?? out.days;
					const fit = s.from < hist && s.to >= hist ? hist - 1 : s.to;
					let asked = 0;
					for (let t = s.from; t <= fit; t++) asked += D[t]!;
					const lo = Math.max(d0 + s.from, from);
					// No allocation in force on the days it is fitted on (engine ≥ 1.70.0): the modelled demand, factor 1.
					if (lo <= d0 + fit && !own.some((a) => (!a.validFrom || toEpochDay(a.validFrom) <= d0 + fit) && (!a.validTo || toEpochDay(a.validTo) >= lo))) {
						unlicensed++;
						if (k[s.from] !== 1) bad.push(`seed ${seed} ${n.id} ${s.wy}: factor ${k[s.from]} with no allocation in force, not 1`);
						continue;
					}
					let reg = 0;
					for (const a of own) {
						const a0 = Math.max(lo, a.validFrom ? toEpochDay(a.validFrom) : -Infinity);
						const a1 = Math.min(d0 + fit, a.validTo ? toEpochDay(a.validTo) : Infinity);
						if (a1 >= a0) reg += (a.volumeM3PerYear * (a1 - a0 + 1)) / yearDays(s.wy);
					}
					if (asked > 1e-9) {
						scaled++;
						if (Math.abs(asked - reg) > 1e-9 * Math.max(1, reg)) bad.push(`seed ${seed} ${n.id} ${s.wy}: asked ${asked} ≠ registered ${reg}`);
					}
				}
			}
			if (bad.length > 8) break;
		}
		expect(bad).toEqual([]);
		expect(scaled).toBeGreaterThan(50);
		expect(unlicensed).toBeGreaterThan(5);
	});
});

// ---------------------------------------------------------------------------
// The summary against the Allocations tab's own path (backend runUse.ts).
// ---------------------------------------------------------------------------

const RUN_USE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../backend/src/allocations/runUse.ts'), 'utf8');
/** The run_series keys runUseNodes selects: its IN list and its LIKE prefixes. */
function backendKeys(): { exact: Set<string>; prefixes: string[] } {
	const where = /key IN \(([^)]*)\)((?:\s*OR key LIKE '[^']*')*)/.exec(RUN_USE);
	if (!where) throw new Error('runUse.ts: no key IN (…) clause found');
	const exact = new Set([...where[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
	const prefixes = [...where[2]!.matchAll(/LIKE '([^']*)'/g)].map((m) => m[1]!.replace(/\\\\_/g, '_').replace(/\\_/g, '_').replace(/%$/, ''));
	return { exact, prefixes };
}

/** AllocationUseNode as runUseNodes builds it from the stored series. */
function useNodesLikeBackend(input: ModelInput, out: ModelOutput): AllocationUseNode[] {
	const { exact, prefixes } = backendKeys();
	const picked = out.series.filter((s) => s.nodeId !== null && (exact.has(s.key) || prefixes.some((p) => s.key.startsWith(p))));
	const get = (id: string, key: string) => picked.find((s) => s.nodeId === id && s.key === key)?.values ?? null;
	return input.model.nodes
		.filter((n) => (n.kind === 'farm' || n.kind === 'user') && get(n.id, 'supplied'))
		.map((n) => ({
			nodeId: n.id,
			name: n.name,
			kind: n.kind as 'farm' | 'user',
			supplied: get(n.id, 'supplied')!,
			groundwater: get(n.id, 'groundwater_used'),
			groundwaterToDam: get(n.id, 'groundwater_to_dam'),
			riverAbstraction: get(n.id, 'river_abstraction'),
			riverTakes: picked.filter((s) => s.nodeId === n.id && (s.key === 'offtake_used' || s.key.startsWith('river_take@'))).map((s) => s.values),
			intakeTake: get(n.id, 'intake_take'),
			receivedAtIntake: get(n.id, 'received_at_intake')
		}));
}

describe('deep: RunSummary.allocations is compareAllocations on the run’s own series (§2.12)', () => {
	it('the backend reads exactly the keys the engine’s summary passes', () => {
		const { exact, prefixes } = backendKeys();
		expect([...exact].sort()).toEqual(['groundwater_to_dam', 'groundwater_used', 'intake_take', 'offtake_used', 'received_at_intake', 'river_abstraction', 'supplied']);
		expect(prefixes).toEqual(['river_take@']);
	});

	for (const mode of ['none', 'cap', 'fullAllocation'] as const) {
		it(`mode ${mode}: whole years, years over and the means per node and source; the groundwater side is the groundwater use table`, () => {
			const bad: string[] = [];
			let compared = 0;
			let gwRows = 0;
			for (const seed of SEEDS.slice(0, 45)) {
				const input = withAllocations(randomInput(seed, GEN), seed, mode);
				const out = runModel(input);
				const sum = out.summary.allocations;
				if (!input.model.allocations!.length) continue;
				if (!sum) {
					bad.push(`seed ${seed}: no summary.allocations`);
					continue;
				}
				const tol = input.settings.allocationTolerance ?? 0.1;
				const cmp = compareAllocations({ startDate: out.startDate, nodes: useNodesLikeBackend(input, out), allocations: usableAllocations(input.model.allocations, []), tolerance: tol });
				const byId = new Map(cmp.nodes.map((c) => [c.nodeId, c]));
				for (const n of sum.nodes) {
					const c = byId.get(n.nodeId)!;
					for (const src of n.sources) {
						const side = src.waterSource === 'surface' ? c.surface : c.groundwater;
						compared++;
						const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));
						if (src.wholeYears !== side.wholeYears || src.yearsOver !== side.yearsOver || !close(src.meanModelledM3PerYear, side.meanModelledM3PerYear) || !close(src.meanRegisteredM3PerYear, side.meanRegisteredM3PerYear))
							bad.push(`seed ${seed} ${n.nodeId} ${src.waterSource}: summary ${JSON.stringify([src.wholeYears, src.yearsOver, src.meanModelledM3PerYear, src.meanRegisteredM3PerYear])} vs tab ${JSON.stringify([side.wholeYears, side.yearsOver, side.meanModelledM3PerYear, side.meanRegisteredM3PerYear])}`);
					}
					// Every node with a take allocation is listed, with each source it has one for.
					const own = (input.model.allocations ?? []).filter((a) => a.nodeId === n.nodeId && a.waterUse !== '21b');
					const srcs = [...new Set(own.map((a) => a.waterSource))].sort();
					if (JSON.stringify(n.sources.map((s) => s.waterSource).sort()) !== JSON.stringify(srcs)) bad.push(`seed ${seed} ${n.nodeId}: sources ${n.sources.map((s) => s.waterSource)} vs ${srcs}`);
				}
				// The groundwater side per water year is the groundwater use table's abstraction (to the crop + into the dam).
				for (const row of out.summary.groundwaterAnnualUse ?? []) {
					const y = byId.get(row.nodeId)?.groundwater.years.find((x) => x.waterYear === row.waterYear);
					if (row.abstractionM3 > 0) gwRows++;
					if (!y || Math.abs(y.modelledM3 - row.abstractionM3) > 1e-9 * Math.max(1, row.abstractionM3)) bad.push(`seed ${seed} ${row.nodeId} ${row.waterYear}: groundwater side ${y?.modelledM3} ≠ table ${row.abstractionM3}`);
				}
				if (bad.length > 8) break;
			}
			expect(bad).toEqual([]);
			expect(compared).toBeGreaterThan(40);
			expect(gwRows).toBeGreaterThan(5);
		});
	}
});

describe('deep: a capped run resumed inside a water year (§2.12a, §2.16)', () => {
	it('the resumed run’s capReached counts the year’s use before the snapshot; later years are the whole run’s; every day to the bit', () => {
		const bad: string[] = [];
		let resumed = 0;
		for (const seed of SEEDS.slice(0, 50)) {
			const input = withAllocations(randomInput(seed, GEN), seed, 'cap');
			const full = runModel(input);
			if (full.days < 60) continue;
			const k = Math.floor(full.days / 2);
			const d0 = toEpochDay(full.startDate);
			const at = fromEpochDay(d0 + k);
			const { snapshot } = runModelCapturing(input, at);
			const tail = runModelFrom(snapshot, input);
			resumed++;
			const m = new Map(full.series.map((x) => [`${x.nodeId}/${x.key}`, x.values]));
			for (const x of tail.series) {
				const w = m.get(`${x.nodeId}/${x.key}`);
				if (!w) continue;
				for (let i = 0; i < x.values.length; i++) if (!Object.is(x.values[i], w[k + i])) { bad.push(`seed ${seed} ${x.nodeId}/${x.key} day ${i}: ${x.values[i]} vs ${w[k + i]}`); break; }
			}
			for (const n of tail.summary.allocations?.nodes ?? []) {
				const f = full.summary.allocations!.nodes.find((x) => x.nodeId === n.nodeId)!;
				for (const src of n.sources) {
					const fs = f.sources.find((x) => x.waterSource === src.waterSource)!;
					const firstWy = waterYearOf(d0 + k);
					const want = (fs.capReached ?? []).filter((r) => r.waterYear >= firstWy).map((r) => r.waterYear);
					const got = (src.capReached ?? []).map((r) => r.waterYear);
					if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`seed ${seed} ${n.nodeId} ${src.waterSource}: resumed capReached ${JSON.stringify(got)} vs whole run ${JSON.stringify(want)}`);
					// Years after the snapshot's own: limitBound identical.
					const later = (l: typeof src.limitBound) => JSON.stringify((l ?? []).filter((y) => y.waterYear > firstWy));
					if (later(src.limitBound) !== later(fs.limitBound)) bad.push(`seed ${seed} ${n.nodeId} ${src.waterSource}: limitBound after ${firstWy} differs`);
				}
			}
			if (bad.length > 6) break;
		}
		expect(bad).toEqual([]);
		expect(resumed).toBeGreaterThan(30);
	});
});
