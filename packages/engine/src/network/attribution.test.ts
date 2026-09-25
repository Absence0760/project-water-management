import { describe, expect, it } from 'vitest';
import { attributeEwrShortfall, type AttributionInput } from './attribution';
import { Rng } from '../random';

/**
 * A one-day (or n-day) network given directly as the daily columns the rule
 * reads, so each case can be worked by hand. `down[i]` = the node i drains
 * into (-1 = the outlet). Farms default to no irrigation return (k = 1).
 */
interface Case {
	kind: ('farm' | 'gauge')[];
	down: number[];
	H?: number[][];
	I: number[][];
	U: number[][];
	G?: number[][];
	k?: number[];
	transfers?: { from: number; to: number; volume: number[] }[];
	/** Site node → daily shortfall (≤ 0). The outlet must be listed. */
	sites: [number, number[]][];
}

function build(c: Case): AttributionInput {
	const n = c.kind.length;
	const days = c.I[0]!.length;
	const upstream = c.kind.map((_, i) => c.down.flatMap((d, j) => (d === i ? [j] : [])));
	const order: number[] = [];
	const seen = new Set<number>();
	const visit = (i: number) => {
		if (seen.has(i)) return;
		for (const u of upstream[i]!) visit(u);
		seen.add(i);
		order.push(i);
	};
	for (let i = 0; i < n; i++) visit(i);
	// H = Σ upstream U unless given.
	const H = c.H ?? c.kind.map((_, i) => Array.from({ length: days }, (_, t) => upstream[i]!.reduce((s, u) => s + c.U[u]![t]!, 0)));
	return {
		days,
		kind: c.kind,
		upstream,
		order,
		inflow: H,
		runoff: c.I,
		outflow: c.U,
		supplied: c.G ?? c.kind.map(() => new Array(days).fill(0)),
		consumptivePerSupplied: c.k ?? c.kind.map(() => 1),
		transfers: c.transfers ?? [],
		sites: c.sites.map(([node, shortfall]) => ({ node, shortfall }))
	};
}

const r9 = (xs: ArrayLike<number>) => Array.from(xs, (x) => Math.round(x * 1e9) / 1e9 + 0);

describe('attributeEwrShortfall — Q17 net-impact pro rata at EWR sites', () => {
	it('charges each farm upstream of the outlet in proportion to its net impact (H + I + J) − U', () => {
		// A and B drain into the outlet farm C; D = 50.
		const out = attributeEwrShortfall(
			build({
				kind: ['farm', 'farm', 'farm'],
				down: [2, 2, -1],
				I: [[100], [50], [30]],
				U: [[40], [30], [60]],
				sites: [[2, [-50]]]
			})
		);
		// e_A = 100 − 40 = 60, e_B = 50 − 30 = 20, e_C = H (40 + 30) + 30 − 60 = 40 → E = 120.
		expect(r9(out.charge.map((c) => c[0]!))).toEqual(r9([-25, (-50 * 20) / 120, (-50 * 40) / 120]));
		expect(r9(out.sites[0]!.charged)).toEqual([-50]);
		expect(r9(out.sites[0]!.natural)).toEqual([0]);
		expect(Array.from(out.binding[0]!)).toEqual([0]);
	});

	it('does not charge a farm that adds water on the day, nor credit it', () => {
		// B releases from its dam: U > H + I. Only A is charged, and never more than it took.
		const out = attributeEwrShortfall(
			build({ kind: ['farm', 'farm', 'gauge'], down: [2, 2, -1], I: [[100], [10], [0]], U: [[70], [40], [110]], sites: [[2, [-80]]] })
		);
		expect(out.charge[1]![0]).toBe(0);
		// E = 30 (A only) < D = 80: A is charged its whole impact, the rest is natural.
		expect(out.charge[0]![0]).toBeCloseTo(-30, 12);
		expect(out.sites[0]!.charged[0]).toBeCloseTo(-30, 12);
		expect(out.sites[0]!.natural[0]).toBeCloseTo(-50, 12);
	});

	it('charges nothing where the site meets its EWR, even when a reach upstream is short (the confluence example)', () => {
		// Tributary A is short on its own reach; B has water to spare; the outlet gauge is met.
		const out = attributeEwrShortfall(
			build({ kind: ['farm', 'farm', 'gauge'], down: [2, 2, -1], I: [[100], [400], [0]], U: [[0], [400], [400]], sites: [[2, [0]]] })
		);
		expect(r9(out.charge[0]!)).toEqual([0]);
		expect(r9(out.sites[0]!.charged)).toEqual([0]);
		expect(r9(out.sites[0]!.natural)).toEqual([0]);
		expect(Array.from(out.binding[0]!)).toEqual([-1]);
	});

	it('a float residue at the scale of a dam or an upstream flow is not an impact (engine 0.19.1)', () => {
		// A full dam of 253 927 m³ spills its runoff: e = I − spill is exact 0 in real arithmetic,
		// but the spill is computed at the storage's scale, so e comes out ±1e-11 depending on
		// summation order. Judged on flows alone (12.5 m³) that passes the noise test.
		const I = 12.49676966671541;
		const spill = I - 1.4550138871527452e-11;
		// Farm B beside it takes 10 m³ that day, so the site's shortfall is charged to someone.
		const full = build({ kind: ['farm', 'farm', 'gauge'], down: [2, 2, -1], I: [[I], [50], [0]], U: [[spill], [40], [spill + 40]], sites: [[2, [-100]]] });
		const withDam = attributeEwrShortfall({ ...full, storage: [[253927], [0], [0]] });
		expect(withDam.charge[0]![0]).toBe(0);
		expect(withDam.charge[1]![0]).toBeCloseTo(-10, 9);
		// Without the storage it would be charged: the storage is what sizes the noise here.
		expect(attributeEwrShortfall(full).charge[0]![0]).toBeLessThan(0);

		// An empty farm B below a farm A whose outflow carries a 1e-13 residue: B's own volumes
		// are all noise, so they can't size it; A's (1 000 m³ in) do.
		const residue = build({ kind: ['farm', 'farm', 'gauge'], down: [1, 2, -1], I: [[1000], [0], [0]], U: [[1.1368683772161603e-13], [0], [0]], sites: [[2, [-50]]] });
		expect(attributeEwrShortfall(residue).charge[1]![0]).toBe(0);
		// A real impact on the same day is still charged.
		expect(attributeEwrShortfall(residue).charge[0]![0]).toBeCloseTo(-50, 9);
	});

	it('with no impact at all the whole shortfall is natural (a drought no one caused)', () => {
		const out = attributeEwrShortfall(build({ kind: ['farm', 'gauge'], down: [1, -1], I: [[10], [0]], U: [[10], [10]], sites: [[1, [-40]]] }));
		expect(out.charge[0]![0]).toBe(0);
		expect(out.sites[0]!.charged[0]).toBe(0);
		expect(out.sites[0]!.natural[0]).toBe(-40);
	});

	it('charges a transfer out of a site’s catchment to its source, and credits the import to the receiver', () => {
		// A (above gauge g) sends 30 to C (below g, above the outlet). At g, A's
		// transfer is an export: e_A,g = I 50 + J_int 0 − U 20 = 30 (the transfer
		// counts). At the outlet J_int = J: e_A = 50 − 30 − 20 = 0 (the water is
		// still in the catchment, C used it).
		const out = attributeEwrShortfall(
			build({
				kind: ['farm', 'gauge', 'farm', 'gauge'],
				down: [1, 2, 3, -1],
				I: [[50], [0], [0], [0]],
				U: [[20], [20], [10], [10]],
				transfers: [{ from: 0, to: 2, volume: [30] }],
				sites: [
					[3, [-40]],
					[1, [-10]]
				]
			})
		);
		// g: D = 10, E = 30 → A charged 10 there. Outlet: e_C = H 20 + J 30 − U 10 = 40, e_A = 0 → C charged 40 (D 40).
		expect(out.charge[0]![0]).toBeCloseTo(-10, 12);
		expect(out.charge[2]![0]).toBeCloseTo(-40, 12);
		// A's binding site is the gauge (site index 1), C's the outlet (0).
		expect(Array.from(out.binding[0]!)).toEqual([1]);
		expect(Array.from(out.binding[2]!)).toEqual([0]);
	});

	it('a farm under several sites carries the largest of its charges, not the sum; ties go to the most downstream site', () => {
		// A → g → outlet farm B. A's impact 40; B's 0. Both sites short by 20: A's charge is 20 at each.
		const out = attributeEwrShortfall(
			build({
				kind: ['farm', 'gauge', 'farm'],
				down: [1, 2, -1],
				I: [[50], [0], [0]],
				U: [[10], [10], [10]],
				sites: [
					[2, [-20]],
					[1, [-20]]
				]
			})
		);
		expect(out.charge[0]![0]).toBeCloseTo(-20, 12);
		expect(Array.from(out.binding[0]!)).toEqual([0]); // the outlet, the more downstream of the two
		// Listing the sites the other way round binds the same site.
		const flipped = attributeEwrShortfall(
			build({
				kind: ['farm', 'gauge', 'farm'],
				down: [1, 2, -1],
				I: [[50], [0], [0]],
				U: [[10], [10], [10]],
				sites: [
					[1, [-20]],
					[2, [-20]]
				]
			})
		);
		expect(Array.from(flipped.binding[0]!)).toEqual([1]);
	});

	it('splits the charge into irrigation and storage parts: c = consumptive irrigation G·k, o = e − c', () => {
		// A: G 30 with k = 0.8 → c = 24; e = I 100 − U 40 = 60 → o = 36 (stored).
		// Charged 30 (D) → A_irr = 30 × 24 / 60 = 12, A_store = 18.
		// Z (no demand, stores 20): e = 20, c = 0 → all of its charge is storage.
		const out = attributeEwrShortfall(
			build({
				kind: ['farm', 'farm', 'gauge'],
				down: [2, 2, -1],
				I: [[100], [20], [0]],
				U: [[40], [0], [40]],
				G: [[30], [0], [0]],
				k: [0.8, 1, 1],
				sites: [[2, [-40]]]
			})
		);
		// E = 80, D = 40 → A: 30, Z: 10.
		expect(out.charge[0]![0]).toBeCloseTo(-30, 12);
		expect(out.chargeIrrigation[0]![0]).toBeCloseTo((-30 * 24) / 60, 12);
		expect(out.charge[1]![0]).toBeCloseTo(-10, 12);
		expect(out.chargeIrrigation[1]![0]).toBe(0);
	});

	it('with o ≤ 0 (an import or a dam drawdown) the whole charge is irrigation', () => {
		// e = 10 < c = 24: A_irr = A.
		const out = attributeEwrShortfall(
			build({ kind: ['farm', 'gauge'], down: [1, -1], I: [[50], [0]], U: [[40], [40]], G: [[30], [0]], k: [0.8, 1], sites: [[1, [-5]]] })
		);
		expect(out.charge[0]![0]).toBeCloseTo(-5, 12);
		expect(out.chargeIrrigation[0]![0]).toBeCloseTo(-5, 12);
	});

	describe('invariants on random trees', () => {
		/** A random tree of 2–9 nodes, random columns and transfers, over 5 days. */
		function randomCase(seed: number): Case {
			const rng = new Rng(seed);
			const n = 2 + Math.floor(rng.next() * 8);
			const kind: ('farm' | 'gauge')[] = [];
			const down: number[] = [];
			// Node n−1 is the outlet; every other node drains to a later one.
			for (let i = 0; i < n; i++) {
				kind.push(i < n - 1 && rng.next() < 0.3 ? 'gauge' : 'farm');
				down.push(i === n - 1 ? -1 : i + 1 + Math.floor(rng.next() * (n - 1 - i)));
			}
			const days = 5;
			const col = (scale: number) => kind.map((k) => Array.from({ length: days }, () => (k === 'farm' ? rng.next() * scale : 0)));
			const I = col(100);
			const G = col(60);
			const U: number[][] = kind.map(() => new Array(days).fill(0));
			// Random outflows (not a physical balance: the rule only reads the columns).
			for (let i = 0; i < n; i++) for (let t = 0; t < days; t++) U[i]![t] = rng.next() * 150;
			const farms = kind.flatMap((k, i) => (k === 'farm' ? [i] : []));
			const transfers = farms.length > 1 && rng.next() < 0.6 ? [{ from: farms[0]!, to: farms.at(-1)!, volume: Array.from({ length: days }, () => rng.next() * 40) }] : [];
			const sites: [number, number[]][] = [[n - 1, Array.from({ length: days }, () => (rng.next() < 0.3 ? 0 : -rng.next() * 200))]];
			for (let i = 0; i < n - 1; i++) if (kind[i] === 'gauge') sites.push([i, Array.from({ length: days }, () => (rng.next() < 0.3 ? 0 : -rng.next() * 100))]);
			return { kind, down, I, U, G, k: kind.map(() => 0.5 + rng.next() * 0.5), transfers, sites };
		}

		const ancestors = (c: Case, s: number) => {
			const set = new Set<number>([s]);
			let grew = true;
			while (grew) {
				grew = false;
				c.down.forEach((d, i) => {
					if (set.has(d) && !set.has(i)) {
						set.add(i);
						grew = true;
					}
				});
			}
			return set;
		};

		it('Σ charges + natural = D; 0 ≤ A ≤ e⁺; nothing charged outside a site’s catchment or on a met day; the farm charge is the max over sites', () => {
			for (let seed = 1; seed <= 300; seed++) {
				const c = randomCase(seed);
				const input = build(c);
				const out = attributeEwrShortfall(input, { perSite: true });
				for (const [si, site] of out.sites.entries()) {
					const F = ancestors(c, site.node);
					for (let t = 0; t < input.days; t++) {
						const D = Math.max(-c.sites[si]![1][t]!, 0);
						const tol = 1e-9 * Math.max(1, D);
						let sumA = 0;
						for (let f = 0; f < c.kind.length; f++) {
							const A = 0 - out.perSite![si]![f]![t]!;
							sumA += A;
							if (c.kind[f] === 'gauge' || !F.has(f)) {
								expect(A, `seed ${seed} site ${si} farm ${f}`).toBe(0);
								continue;
							}
							let Jint = 0;
							for (const tr of c.transfers ?? []) {
								if (!F.has(tr.from) || !F.has(tr.to)) continue;
								if (tr.to === f) Jint += tr.volume[t]!;
								if (tr.from === f) Jint -= tr.volume[t]!;
							}
							const e = input.inflow[f]![t]! + c.I[f]![t]! + Jint - c.U[f]![t]!;
							expect(A).toBeGreaterThanOrEqual(0);
							expect(A, `seed ${seed}`).toBeLessThanOrEqual(Math.max(e, 0) + tol);
							if (D === 0) expect(A).toBe(0);
						}
						const N = -site.natural[t]!;
						expect(N).toBeGreaterThanOrEqual(0);
						expect(Math.abs(sumA + N - D), `seed ${seed} site ${si} day ${t}`).toBeLessThanOrEqual(tol);
						expect(Math.abs(-site.charged[t]! - sumA)).toBeLessThanOrEqual(tol);
					}
				}
				for (let f = 0; f < c.kind.length; f++) {
					for (let t = 0; t < input.days; t++) {
						const best = Math.max(0, ...out.perSite!.map((s) => -s[f]![t]!));
						expect(-out.charge[f]![t]!).toBeCloseTo(best, 9);
						const irr = -out.chargeIrrigation[f]![t]!;
						expect(irr).toBeGreaterThanOrEqual(0);
						expect(irr).toBeLessThanOrEqual(-out.charge[f]![t]! + 1e-9);
						// The irrigation part never exceeds the farm's consumptive irrigation.
						expect(irr).toBeLessThanOrEqual(c.G![f]![t]! * c.k![f]! + 1e-9);
					}
				}
			}
		});

		it('does not depend on the order the nodes are listed in', () => {
			for (let seed = 1; seed <= 100; seed++) {
				const c = randomCase(seed);
				const n = c.kind.length;
				// Reverse the node indices.
				const p = (i: number) => n - 1 - i;
				const perm = <T>(xs: T[]) => xs.map((_, i) => xs[p(i)]!);
				const r: Case = {
					kind: perm(c.kind),
					down: perm(c.down).map((d) => (d < 0 ? d : p(d))),
					I: perm(c.I),
					U: perm(c.U),
					G: perm(c.G!),
					k: perm(c.k!),
					transfers: (c.transfers ?? []).map((tr) => ({ ...tr, from: p(tr.from), to: p(tr.to) })),
					sites: c.sites.map(([s, d]) => [p(s), d])
				};
				const a = attributeEwrShortfall(build(c));
				const b = attributeEwrShortfall(build(r));
				for (let f = 0; f < n; f++) {
					for (let t = 0; t < 5; t++) {
						expect(b.charge[p(f)]![t]!).toBeCloseTo(a.charge[f]![t]!, 9);
						expect(b.chargeIrrigation[p(f)]![t]!).toBeCloseTo(a.chargeIrrigation[f]![t]!, 9);
						const ba = b.binding[p(f)]![t]!;
						const aa = a.binding[f]![t]!;
						expect(ba < 0 ? -1 : b.sites[ba]!.node).toBe(aa < 0 ? -1 : p(a.sites[aa]!.node));
					}
				}
			}
		});
	});
});
