// End-to-end, round 2: long runs. Sixty water years of daily GR4J (21 915
// days, 15 leap days) through a two-unit network with a dam, crops,
// transfers and an EWR; then 40 years for the firm yield. What a long record
// adds over the round-1 tests: the calendar counts (water years, leap days,
// the 28.25-day February adding up to whole years, docs/model.md §2.3), the
// summaries over many years (§2.9 grid, §2.11a assurance, §2.11b account,
// §2.13 yield, §2.14 classes) recounted from the daily series, and no drift:
// the GR4J store balance and the dam's storage, accumulated by hand over
// every day of 60 years, against the engine's.
//
// The drift tolerance. A day's storage update is a handful of float
// additions (S0 = Q + Pd − E − Sp, + K + M + O + J − G, then the cap), each
// with a relative error of at most u = 2⁻⁵³ ≈ 1.1 × 10⁻¹⁶ of its operands; so
// after N days the accumulated error of Q is at most about 8u × Σ|terms| (the
// bound grows with the throughput, not with N × the storage). 10⁻¹² ×
// Σ|terms| leaves a margin of ~10³ over that bound, while losing a single
// day's flow (10⁻⁵ of 60 years' throughput or more) would fail it by far.
// Invented values only.
import { describe, expect, it } from 'vitest';
import type { DemandObject, ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModel, runModelChecked } from '../run';
import { firmYield } from '../network/yield';
import { testCatchment } from '../outlook/testCatchment';
import { classifyRunWaterYears } from '../views/yearClasses';

const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const DIM = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30];
const KC = [0.4, 0.6, 0.8, 0.9, 0.8, 0.6, 0.4, 0.2, 0.1, 0.1, 0.2, 0.3];
const EWR = [900, 800, 700, 650, 600, 650, 700, 800, 900, 1000, 1000, 950].map((v) => v * 4);

const NODE: Omit<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId'> = {
	sortOrder: 0,
	areaKm2: 0,
	areaHiKm2: 0,
	areaLoKm2: 0,
	flowShareManual: null,
	pctUpstreamToDam: 1,
	pctRunoffToDam: 1,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0
};

/** Deterministic invented rain with wet and dry years (a seeded year factor). */
function rainRecord(n: number, seed: number): number[] {
	let s = seed >>> 0;
	const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
	let yf = 1;
	return Array.from({ length: n }, (_, t) => {
		if (t % 365 === 0) yf = 0.3 + 1.4 * r();
		const u = r();
		const v = u < 0.62 ? 0 : u < 0.8 ? r() * 4 : u < 0.97 ? r() * 30 : 60 + r() * 90;
		return Math.round(v * yf * 10) / 10;
	});
}

const MS_DAY = 86_400_000;
const epoch = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / MS_DAY;
const isoOf = (e: number) => new Date(e * MS_DAY).toISOString().slice(0, 10);
const wym = (e: number) => (new Date(e * MS_DAY).getUTCMonth() + 3) % 12;
const wyOf = (e: number) => {
	const d = new Date(e * MS_DAY);
	return d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};

const START = '1960-10-01';
const END = '2020-09-30';
const DAYS = epoch(END) - epoch(START) + 1;
const CROP_A = 1_500_000;
const CROP_B = 600_000;
const CAP = 600_000;

function sixtyYears(): ModelInput {
	return {
		settings: {
			runoffModel: 'gr4j',
			apanMm: APAN as never,
			ewrPragmaticM3PerDay: EWR as never,
			effectiveRainFraction: 0,
			lakeEvapFactor: 0.75
		} as ModelInput['settings'],
		model: {
			nodes: [
				{ ...NODE, id: 'G', name: 'Outlet', kind: 'gauge', downstreamNodeId: null },
				{ ...NODE, id: 'A', name: 'Unit A', kind: 'farm', downstreamNodeId: 'G', areaKm2: 25, damCapacityM3: CAP, damInitialPct: 0.5, damMinPct: 0.05, damAreaFullM2: 150_000, damSeepagePerDay: 0.0005, irrigationEfficiency: 0.85, lossReturnFraction: 0.4, pctUpstreamToDam: 0.6, pctRunoffToDam: 0.8, divertCapacityM3Day: 2000 },
				{ ...NODE, id: 'B', name: 'Unit B', kind: 'farm', downstreamNodeId: 'A', areaKm2: 15, damCapacityM3: 200_000, damInitialPct: 0.3, damAreaFullM2: 60_000, irrigationEfficiency: 0.9, lossReturnFraction: 0.5 }
			],
			crops: [{ id: 'c', name: 'Crop', cropFactor: KC }],
			cropAreas: [
				{ nodeId: 'A', cropId: 'c', areaM2: CROP_A },
				{ nodeId: 'B', cropId: 'c', areaM2: CROP_B }
			],
			transfers: [{ id: 't', fromNodeId: 'B', toNodeId: 'A', months: [11, 12, 1, 2], maxRateM3s: 0.02, dailyCapM3: 1500, minStoragePct: 0.2, enabled: true, priority: 1 }]
		},
		series: { rain_catchment_mm: { startDate: START, values: rainRecord(DAYS, 2024) } }
	};
}

const col = (o: ModelOutput, id: string | null, key: string): number[] => {
	const s = o.series.find((x) => x.nodeId === id && x.key === key);
	if (!s) throw new Error(`no series ${id}/${key}`);
	return s.values;
};
const sum = (a: ArrayLike<number>) => {
	let v = 0;
	for (let i = 0; i < a.length; i++) v += a[i]!;
	return v;
};
const sumAbs = (a: ArrayLike<number>) => {
	let v = 0;
	for (let i = 0; i < a.length; i++) v += Math.abs(a[i]!);
	return v;
};

describe('sixty years of daily GR4J', () => {
	const input = sixtyYears();
	const o = runModelChecked(input);
	const d0 = epoch(o.startDate);

	it('runs every day of the record, passes every self-check and stays finite and non-negative', () => {
		expect([o.startDate, o.endDate, o.days]).toEqual([START, END, 21_915]);
		expect(o.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		for (const s of o.series) {
			if (['rain_final', 'rain_source'].includes(s.key)) continue;
			for (const v of s.values) expect(Number.isFinite(v)).toBe(true);
		}
		for (const k of ['dam_storage', 'supplied', 'spill', 'outflow']) for (const id of ['A', 'B']) expect(Math.min(...col(o, id, k))).toBeGreaterThanOrEqual(0);
	});

	it('the calendar: 15 leap days, 60 complete water years in every summary that counts years', () => {
		let leap = 0;
		for (let t = 0; t < o.days; t++) if (isoOf(d0 + t).endsWith('-02-29')) leap++;
		expect(leap).toBe(15);
		const years = Array.from({ length: 60 }, (_, k) => 1960 + k);
		const g = o.summary.ewrCompliance!;
		expect(g.waterYears).toEqual(years);
		// February (column 4) is 29 days in the 15 water years that end in a leap year.
		g.days.forEach((row, k) => expect(row).toEqual([31, 30, 31, 31, (1961 + k) % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30]));
		const wa = o.summary.supplyAssurance!.waterAccount;
		expect(wa.years.map((y) => y.waterYear)).toEqual(years);
		expect(wa.years.filter((y) => y.days === 366).length).toBe(15);
		expect(sum(wa.years.map((y) => y.days))).toBe(o.days);
		for (const r of o.summary.supplyAssurance!.reliability) expect([r.waterYears, r.partWaterYears ?? 0]).toEqual([60, 0]);
		const cls = classifyRunWaterYears(o);
		expect(cls.years.length).toBe(60);
		expect(cls.excluded).toEqual([]);
	});

	it('the 28.25-day February adds up: Σ crop requirement over 60 years = 60 × Σ area × kc × A-pan ÷ 1000 (§2.3)', () => {
		// 60 Februaries hold 60 × 28 + 15 = 1695 = 60 × 28.25 days, so the daily rate × days gives whole years exactly.
		for (const [id, area] of [['A', CROP_A], ['B', CROP_B]] as const) {
			const want = 60 * APAN.reduce((s, a, m) => s + (area * KC[m]! * a) / 1000, 0);
			expect(Math.abs(sum(col(o, id, 'crop_requirement')) - want)).toBeLessThanOrEqual(1e-12 * want * 10);
			// And day by day: area × kc × A-pan ÷ days in month ÷ 1000.
			const F = col(o, id, 'crop_requirement');
			for (let t = 0; t < o.days; t += 97) {
				const m = wym(d0 + t);
				expect(F[t]).toBeCloseTo((area * KC[m]! * APAN[m]!) / DIM[m]! / 1000, 9);
			}
		}
	});

	it('no drift in the GR4J stores: Σ (rain − AET − Q + exchange) over 60 years = storage end − start, per year and overall', () => {
		const b = o.summary.runoff!;
		const rain = col(o, null, 'rain_used');
		const aet = col(o, null, 'aet');
		const nat = col(o, null, 'natural_flow');
		const ex = o.series.find((s) => s.nodeId === null && s.key === 'exchange')?.values;
		const stores = ['production_store', 'routing_store', 'uh_store'].map((k) => col(o, null, k));
		const toMm = 1 / (b.areaKm2 * 1000);
		let before = b.storageStartMm;
		let acc = 0;
		let scale = b.storageStartMm;
		let yearAcc = 0;
		let yearScale = 0;
		let yearStart = before;
		for (let t = 0; t < o.days; t++) {
			const d = rain[t]! - aet[t]! - nat[t]! * toMm + (ex ? ex[t]! : 0);
			acc += d;
			yearAcc += d;
			const s = rain[t]! + aet[t]! + nat[t]! * toMm + Math.abs(ex ? ex[t]! : 0);
			scale += s;
			yearScale += s;
			const after = stores[0]![t]! + stores[1]![t]! + stores[2]![t]!;
			before = after;
			if (t === o.days - 1 || wym(d0 + t + 1) === 0 && wym(d0 + t) === 11) {
				expect(Math.abs(yearAcc - (after - yearStart))).toBeLessThanOrEqual(1e-12 * (yearScale + yearStart + after));
				yearAcc = 0;
				yearScale = 0;
				yearStart = after;
			}
		}
		expect(Math.abs(acc - (before - b.storageStartMm))).toBeLessThanOrEqual(1e-12 * (scale + before));
		expect(b.storageEndMm).toBeCloseTo(before, 9);
		// The summary's totals are the series' (the whole run, §2.4a).
		expect(Math.abs(b.rainMm - sum(rain))).toBeLessThanOrEqual(1e-12 * sum(rain));
		expect(Math.abs(b.flowMm - sum(nat) * toMm)).toBeLessThanOrEqual(1e-12 * sum(nat) * toMm);
	});

	it('no drift in the dams: storage accumulated by hand over 21 915 days matches the engine on the last day', () => {
		for (const n of input.model.nodes.filter((x) => x.kind === 'farm')) {
			const [Pd, E, Sp, K, M, O, J, G, R] = ['rain_on_dam', 'dam_evaporation', 'dam_seepage', 'upstream_to_dam', 'runoff_to_dam', 'diverted_to_dam', 'transfer', 'supplied', 'spill'].map((k) => col(o, n.id, k));
			const Q = col(o, n.id, 'dam_storage');
			// Q[t] = Q[t−1] + Pd − E − Sp + K + M + O + J − G − R (§2.7 P, Q, R), so Q[N] = Q[0] + Σ of those.
			let q = n.damInitialPct * n.damCapacityM3;
			let scale = q;
			for (let t = 0; t < o.days; t++) {
				const terms = [Pd![t]!, -E![t]!, -Sp![t]!, K![t]!, M![t]!, O![t]!, J![t]!, -G![t]!, -R![t]!];
				for (const v of terms) {
					q += v;
					scale += Math.abs(v);
				}
			}
			expect(Math.abs(q - Q.at(-1)!), n.id).toBeLessThanOrEqual(1e-12 * scale);
			// And it was a real test: the dam filled, spilled and was drawn down many times over the 60 years.
			expect(sum(R!)).toBeGreaterThan(n.damCapacityM3);
			expect(sum(G!)).toBeGreaterThan(10 * n.damCapacityM3);
		}
	});

	it('the catchment closes over 60 years: in = out + Δ storage to 10⁻¹⁰ of the throughput, each year too (§2.11b)', () => {
		const wa = o.summary.supplyAssurance!.waterAccount;
		for (const y of [...wa.years, wa.total]) expect(Math.abs(y.residualM3)).toBeLessThanOrEqual(1e-10 * y.scaleM3);
		// The total row is the sum of the year rows (no drift between the two ways of adding).
		for (const k of ['naturalFlowM3', 'outflowM3', 'consumptiveIrrigationM3', 'damEvaporationM3', 'rainOnDamsM3'] as const) {
			const byYear = sum(wa.years.map((y) => y[k]));
			expect(Math.abs(byYear - wa.total[k])).toBeLessThanOrEqual(1e-12 * Math.abs(wa.total[k]) + 1e-9);
		}
		// The years chain: each opens on the last's closing storage.
		for (let k = 1; k < wa.years.length; k++) expect(wa.years[k]!.openingStorageM3).toBe(wa.years[k - 1]!.closingStorageM3);
		expect(wa.total.naturalFlowM3).toBeCloseTo(sum(col(o, null, 'natural_flow')), 3);
	});

	it('the summaries over 60 years equal their daily series', () => {
		for (const f of o.summary.farms) {
			const D = col(o, f.nodeId, 'demand');
			const G = col(o, f.nodeId, 'supplied');
			expect(f.avgDemandM3Day).toBeCloseTo(sum(D) / o.days, 6);
			expect(f.avgSuppliedM3Day).toBeCloseTo(sum(G) / o.days, 6);
			expect(f.fractionSupplied).toBeCloseTo(sum(G) / sum(D), 12);
		}
		expect(o.summary.catchment.meanNaturalFlowM3Day).toBeCloseTo(sum(col(o, null, 'natural_flow')) / o.days, 6);
		const q = col(o, null, 'simulated_outflow');
		const e = col(o, null, 'ewr');
		const notMet = q.filter((v, t) => v - e[t]! < -1e-12 * Math.max(v, e[t]!)).length;
		expect(o.summary.catchment.ewrDaysNotMet).toBe(notMet);
		expect(notMet).toBeGreaterThan(0);
		expect(notMet).toBeLessThan(o.days);
		expect(sum(o.summary.ewrCompliance!.outlet.daysNotMet.flat())).toBe(notMet);
	});

	it('assurance of supply over 60 years, recounted from the daily series (§2.11a)', () => {
		for (const r of o.summary.supplyAssurance!.reliability) {
			const D = col(o, r.nodeId, 'demand');
			const G = col(o, r.nodeId, 'supplied');
			let demandDays = 0;
			let metDays = 0;
			let runs = 0;
			let longest = 0;
			let cur = 0;
			const years = new Map<number, { d: number; g: number }>();
			for (let t = 0; t < o.days; t++) {
				const y = years.get(wyOf(d0 + t)) ?? { d: 0, g: 0 };
				y.d += D[t]!;
				y.g += G[t]!;
				years.set(wyOf(d0 + t), y);
				const met = D[t]! - G[t]! <= 1e-9 * D[t]!;
				if (D[t]! > 0) {
					demandDays++;
					if (met) metDays++;
				}
				if (D[t]! > 0 && !met) cur++;
				else if (cur) {
					runs++;
					longest = Math.max(longest, cur);
					cur = 0;
				}
			}
			if (cur) {
				runs++;
				longest = Math.max(longest, cur);
			}
			const yearsMet = [...years.values()].filter((y) => y.d > 0 && y.g / y.d >= 0.9).length;
			expect([r.demandDays, r.metDays, r.failureRuns, r.longestFailureDays, r.waterYearsMet]).toEqual([demandDays, metDays, runs, longest, yearsMet]);
			expect(r.annualReliability).toBeCloseTo(yearsMet / 60, 12);
			expect(r.volumetricReliability).toBeCloseTo(sum(G) / sum(D), 12);
			// A fair test: some years fail and some pass.
			expect(runs).toBeGreaterThan(0);
		}
	});
});

// --- firm yield over 40 years ------------------------------------------------------

const draft = (nodeId: string, m3Day: number): DemandObject => ({
	id: `draft-${nodeId}`,
	nodeId,
	name: 'Draft',
	category: 'industrial',
	sizing: 'monthly',
	monthlyM3Day: new Array(12).fill(m3Day),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'external',
	enabled: true,
	note: ''
});

function withDraft(base: ModelInput, m3Day: number): ModelInput {
	return { ...base, model: { ...base.model, cropAreas: base.model.cropAreas.filter((c) => c.nodeId !== 'a'), demandObjects: [draft('a', m3Day)] } };
}

function failures(o: ModelOutput): { days: number; years: Set<number> } {
	const d = col(o, 'a', 'demand');
	const def = col(o, 'a', 'deficit');
	const d0 = epoch(o.startDate);
	const years = new Set<number>();
	let days = 0;
	for (let t = 0; t < o.days; t++)
		if (d[t]! > 0 && def[t]! > 1e-9 * d[t]!) {
			days++;
			years.add(wyOf(d0 + t));
		}
	return { days, years };
}

describe('firm yield over a 40-year record (§2.13)', () => {
	const base = testCatchment({ start: '1970-10-01', end: '2010-09-30', seed: 5 });

	it('the 40-year firm yield never fails in a full run; the draft the search reports failing does', () => {
		const y = firmYield(base, 'a');
		expect(y.yieldM3Day).toBeGreaterThan(0);
		expect(y.failureDays).toBe(0);
		expect(failures(runModel(withDraft(base, y.yieldM3Day))).days).toBe(0);
		expect(y.failsAtM3Day).not.toBeNull();
		expect(failures(runModel(withDraft(base, y.failsAtM3Day!))).days).toBeGreaterThan(0);
	});

	it('at 95 % assurance over 40 water years at most 2 years fail, and the yield is at least the firm yield', () => {
		const firm = firmYield(base, 'a').yieldM3Day;
		const y = firmYield(base, 'a', { assurance: 0.95 });
		const f = failures(runModel(withDraft(base, y.yieldM3Day)));
		expect(f.years.size).toBeLessThanOrEqual(2);
		expect(y.failedYears).toBe(f.years.size);
		expect(y.yieldM3Day).toBeGreaterThanOrEqual(firm * (1 - 1e-3));
	});
});
