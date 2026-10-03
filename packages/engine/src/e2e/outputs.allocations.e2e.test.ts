// End-to-end: registered volumes in a run (docs/model.md §2.12, §2.12a).
// Whole runs of a synthetic two-farm catchment with part water years at both
// ends and an allocation whose validity starts on 29 February and ends on
// 1 March, in each mode:
//   none           — RunSummary.allocations against M, R, ratio and status
//                    worked by hand from the run's own series;
//   fullAllocation — each unit's demand over the run's days of a water year
//                    equals the volume registered over those days, the factor
//                    is constant within a year;
//   cap            — a year's use never exceeds its budget (the WHOLE year's
//                    volume, not prorated to the run's days), the room column
//                    is MAX(0, budget − use so far), capReached lists exactly
//                    the years that reached it; a year with no allocation in
//                    force isn't capped (engine ≥ 1.70.0).
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay, waterYearOf } from '../calendar';
import type { AllocationEntry } from '../allocations/compare';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { testCatchment } from '../outlook/testCatchment';

function series(out: ModelOutput, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}:${key}`);
	return s.values;
}
const maybe = (out: ModelOutput, nodeId: string | null, key: string) => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values ?? null;

const wyStart = (wy: number) => toEpochDay(`${wy}-10-01`);
const wyLen = (wy: number) => wyStart(wy + 1) - wyStart(wy);

/** Registered m³ of `a` over epoch days [from, to] of water year wy (§2.12). */
function reg(a: AllocationEntry, wy: number, from: number, to: number): number {
	const lo = Math.max(from, a.validFrom ? toEpochDay(a.validFrom) : -Infinity);
	const hi = Math.min(to, a.validTo ? toEpochDay(a.validTo) : Infinity);
	return hi >= lo ? (a.volumeM3PerYear * (hi - lo + 1)) / wyLen(wy) : 0;
}

/** The run's water years and its days in each, as epoch-day spans. */
function spans(out: ModelOutput): { wy: number; from: number; to: number }[] {
	const d0 = toEpochDay(out.startDate);
	const res: { wy: number; from: number; to: number }[] = [];
	for (let t = 0; t < out.days; t++) {
		const wy = waterYearOf(d0 + t);
		const last = res.at(-1);
		if (last && last.wy === wy) last.to = d0 + t;
		else res.push({ wy, from: d0 + t, to: d0 + t });
	}
	return res;
}

// 15 Mar 2003 … 10 Jan 2009: 2002/03 and 2008/09 are part years; 29 Feb 2004 and 2008 inside.
const BASE = testCatchment({ start: '2003-03-15', end: '2009-01-10', seed: 17 });
const ALLOCS: AllocationEntry[] = [
	{ id: 'a-surface', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 260_000, storageM3: 250_000 },
	{ id: 'b-surface', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: 150_000, validFrom: '2004-02-29', validTo: '2008-03-01' },
	{ id: 'b-surface-2', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: 40_000, validFrom: '2006-10-01' },
	{ id: 'ghost', nodeId: null, waterSource: 'surface', volumeM3PerYear: 1_000 }
];

function withMode(mode: 'none' | 'cap' | 'fullAllocation', allocations = ALLOCS, extra: Record<string, unknown> = {}): ModelInput {
	return { ...BASE, settings: { ...BASE.settings, allocationMode: mode, ...extra }, model: { ...BASE.model, allocations } };
}

describe('outputs e2e: allocations compared with modelled use (§2.12, mode none)', () => {
	const tol = 0.1;
	const out = runModel(withMode('none'));
	it('the run is unchanged by allocations in mode none', () => {
		const plain = runModel(BASE);
		expect(out.series).toEqual(plain.series);
	});
	it('per unit and source: whole years, years over, the mean modelled use and registered volume per whole year', () => {
		const ra = out.summary.allocations!;
		expect(ra.mode).toBe('none');
		expect(ra.tolerance).toBe(tol);
		expect(ra.used).toBe(3);
		expect(ra.notMatched).toBe(1);
		expect(ra.nodes.map((n) => n.nodeId)).toEqual(['a', 'b']);
		for (const n of ra.nodes) {
			const own = ALLOCS.filter((a) => a.nodeId === n.nodeId);
			const sup = series(out, n.nodeId, 'supplied');
			const d0 = toEpochDay(out.startDate);
			let whole = 0;
			let over = 0;
			let sumM = 0;
			let sumR = 0;
			for (const s of spans(out)) {
				let M = 0;
				for (let d = s.from; d <= s.to; d++) M += sup[d - d0]!;
				const R = own.reduce((acc, a) => acc + reg(a, s.wy, s.from, s.to), 0);
				if (s.to - s.from + 1 < wyLen(s.wy)) continue;
				whole++;
				sumM += M;
				sumR += R;
				if (R > 1e-6 && M > R * (1 + tol)) over++;
			}
			const src = n.sources.find((x) => x.waterSource === 'surface')!;
			expect(src.wholeYears).toBe(whole);
			expect(src.yearsOver).toBe(over);
			expect(src.meanModelledM3PerYear!).toBeCloseTo(sumM / whole, 4);
			expect(src.meanRegisteredM3PerYear!).toBeCloseTo(sumR / whole, 4);
			expect(n.sources.some((x) => x.waterSource === 'groundwater')).toBe(false);
		}
	});
});

describe('outputs e2e: a full-allocation run (§2.12a)', () => {
	const input = withMode('fullAllocation');
	const out = runModel(input);
	const plain = runModel(BASE);
	it('each unit asks for exactly its registered volume over the run’s days of each water year, with a factor constant within the year', () => {
		const d0 = toEpochDay(out.startDate);
		for (const id of ['a', 'b']) {
			const own = ALLOCS.filter((a) => a.nodeId === id);
			const dem = series(out, id, 'demand');
			const dem0 = series(plain, id, 'demand');
			const k = series(out, id, 'allocation_demand_factor');
			const scaled = out.summary.allocations!.nodes.find((n) => n.nodeId === id)!.scaled!;
			for (const s of spans(out)) {
				let D = 0;
				let D0 = 0;
				const ks = new Set<number>();
				for (let d = s.from; d <= s.to; d++) {
					D += dem[d - d0]!;
					D0 += dem0[d - d0]!;
					ks.add(k[d - d0]!);
				}
				const R = own.reduce((acc, a) => acc + reg(a, s.wy, s.from, s.to), 0);
				expect(D, `${id} ${s.wy}`).toBeCloseTo(R, 4);
				expect(ks.size, `${id} ${s.wy} factor constant`).toBe(1);
				if (D0 > 0) expect([...ks][0]!).toBeCloseTo(R / D0, 12);
				const row = scaled.find((r) => r.waterYear === s.wy)!;
				expect(row.registeredM3).toBeCloseTo(R, 4);
				expect(row.demandM3).toBeCloseTo(D0, 4);
			}
		}
	});
	it('the demand keeps its own seasonal shape: demand ÷ modelled demand is the year’s factor on every day with demand', () => {
		const d0 = toEpochDay(out.startDate);
		for (const id of ['a', 'b']) {
			const dem = series(out, id, 'demand');
			const dem0 = series(plain, id, 'demand');
			const k = series(out, id, 'allocation_demand_factor');
			for (let t = 0; t < out.days; t++) {
				if (dem0[t]! > 0) expect(Math.abs(dem[t]! - dem0[t]! * k[t]!), `${id} ${fromEpochDay(d0 + t)}`).toBeLessThanOrEqual(1e-9 * Math.max(1, dem[t]!));
			}
		}
	});
});

describe('outputs e2e: an allocation cap (§2.12a)', () => {
	const out = runModel(withMode('cap'));
	it('a year’s surface use never exceeds its budget; the room is MAX(0, budget − use so far); capReached lists exactly the years that reached it', () => {
		const d0 = toEpochDay(out.startDate);
		const uncapped: string[] = [];
		for (const id of ['a', 'b']) {
			const own = ALLOCS.filter((a) => a.nodeId === id);
			const sup = series(out, id, 'supplied');
			const room = series(out, id, 'allocation_room_surface');
			const src = out.summary.allocations!.nodes.find((n) => n.nodeId === id)!.sources.find((x) => x.waterSource === 'surface')!;
			const reached: number[] = [];
			for (const s of spans(out)) {
				// The budget is the whole water year's volume (validity prorated), not the run's days of it.
				const budget = own.reduce((acc, a) => acc + reg(a, s.wy, wyStart(s.wy), wyStart(s.wy + 1) - 1), 0);
				// A year none of the unit's allocations is in force in isn't capped (engine ≥ 1.70.0, #90 Q24): Farm B's
				// first licence starts on 29 February 2004, so its 2002/03 part year has a blank room and isn't listed.
				const inForce = own.some((a) => (!a.validFrom || toEpochDay(a.validFrom) < wyStart(s.wy + 1)) && (!a.validTo || toEpochDay(a.validTo) >= wyStart(s.wy)));
				if (!inForce) {
					for (let d = s.from; d <= s.to; d++) expect(room[d - d0], `${id} room ${fromEpochDay(d)}`).toBeNaN();
					uncapped.push(`${id} ${s.wy}`);
					continue;
				}
				let used = 0;
				for (let d = s.from; d <= s.to; d++) {
					expect(room[d - d0]!, `${id} room ${fromEpochDay(d)}`).toBeCloseTo(Math.max(0, budget - used), 6);
					expect(sup[d - d0]!).toBeLessThanOrEqual(room[d - d0]! + 1e-6);
					used += sup[d - d0]!;
				}
				expect(used, `${id} ${s.wy}`).toBeLessThanOrEqual(budget * (1 + 1e-9) + 1e-9);
				// "use within 10⁻⁹ of the budget".
				if (used >= budget - 1e-9 * budget) reached.push(s.wy);
			}
			expect((src.capReached ?? []).map((r) => r.waterYear), id).toEqual(reached);
			// The cap binds somewhere (else this test proves little): Farm A asks for far more than 260 000 m³ a year.
			if (id === 'a') expect(reached.length).toBeGreaterThan(2);
		}
		expect(uncapped).toEqual(['b 2002']);
		expect(out.summary.warnings.filter((w) => w.includes('is in force'))).toEqual([
			`allocation cap: none of a unit's licences of a source is in force in some water years, so its use of that source isn't capped there, as for a unit with no licence of it (check the licence dates): "${BASE.model.nodes.find((n) => n.id === 'b')!.name}" surface water in water year 2002`
		]);
	});
	it('the first part year (from 15 March) still has the whole year’s volume to take', () => {
		const d0 = toEpochDay(out.startDate);
		const room = series(out, 'a', 'allocation_room_surface');
		// 2002/03 water year: the run's first day has the whole 260 000 m³ (no use before the run is counted).
		expect(room[0]!).toBeCloseTo(260_000, 6);
		// 1 October 2003: a new year, a new budget.
		expect(room[toEpochDay('2003-10-01') - d0]!).toBeCloseTo(260_000, 6);
	});
	it('no cap column in a run of another mode; no factor column in a cap run', () => {
		expect(maybe(out, 'a', 'allocation_demand_factor')).toBeNull();
		expect(maybe(runModel(withMode('none')), 'a', 'allocation_room_surface')).toBeNull();
		expect(maybe(runModel(withMode('fullAllocation')), 'a', 'allocation_room_surface')).toBeNull();
	});
	it('months of use: a winter-only licence gives no room outside its months', () => {
		const allocs: AllocationEntry[] = [{ id: 'a-winter', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 260_000, months: [5, 6, 7, 8] }];
		const o = runModel(withMode('cap', allocs));
		const d0 = toEpochDay(o.startDate);
		const room = series(o, 'a', 'allocation_room_surface');
		const sup = series(o, 'a', 'supplied');
		for (let t = 0; t < o.days; t++) {
			const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
			if (![5, 6, 7, 8].includes(m)) {
				expect(room[t]!).toBe(0);
				expect(sup[t]!).toBeLessThanOrEqual(1e-9);
			}
		}
	});
});
