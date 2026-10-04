// End-to-end, round 2: runs whose window sits on a calendar edge. One- and
// two-day runs that start on 29 Feb, 28 Feb, 1 Mar, 30 Sep, 1 Oct, 31 Dec and
// 1 Jan; a run of exactly one water year; a report window of a single day;
// a run window that reaches past the series it reads. Each day of the
// one-dam catchment is worked by hand from docs/model.md §2.3 (demand, the
// 28.25-day February), §2.7 (the farm balance), §2.7a (dam evaporation and
// rain on the dam) and §2.5/§2.9 (EWR at the gauge), never from the engine's
// own code; the summaries (§2.9, §2.11, §2.11a, §2.11b) are recounted from
// the daily series, and the engine's self-checks must all pass.
// Invented values only (the repo is public).
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModel, runModelChecked, runModelWith, withVerification } from '../run';
import { classifyRunWaterYears } from '../views/yearClasses';

// --- the catchment -----------------------------------------------------------

const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep, mm/month
/** §2.3 step 2: days in each water-year month, February 28.25 (the default). */
const DIM = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30];
const EWR = [900, 800, 700, 650, 600, 650, 700, 800, 900, 1000, 1000, 950]; // m³/day, Oct … Sep
const KC = 0.8;
const CROP_M2 = 60_000;
const CAP = 50_000;
const INIT = 0.4;
const DEAD = 0.1;
const A_FULL = 20_000;
const B_EXP = 0.7;
const K_LAKE = 0.75;
const SEEP = 0.002;

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
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: B_EXP,
	damSeepagePerDay: 0
};

function catchment(start: string, rain: (number | null)[], settings: Record<string, unknown> = {}, series: ModelInput['series'] = {}): ModelInput {
	return {
		settings: {
			apanMm: APAN as never,
			ewrPragmaticM3PerDay: EWR as never,
			effectiveRainFraction: 0,
			lakeEvapFactor: K_LAKE,
			...settings
		} as ModelInput['settings'],
		model: {
			nodes: [
				{ ...NODE, id: 'G', name: 'Outlet gauge', kind: 'gauge', downstreamNodeId: null },
				{
					...NODE,
					id: 'A',
					name: 'Unit A',
					kind: 'farm',
					downstreamNodeId: 'G',
					areaKm2: 4,
					damCapacityM3: CAP,
					damInitialPct: INIT,
					damMinPct: DEAD,
					damAreaFullM2: A_FULL,
					damSeepagePerDay: SEEP,
					irrigationEfficiency: 0.8,
					returnFlowFraction: 0.1
				}
			],
			crops: [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(KC) }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: CROP_M2 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: start, values: rain }, ...series }
	};
}

const col = (o: ModelOutput, id: string | null, key: string): number[] => {
	const s = o.series.find((x) => x.nodeId === id && x.key === key);
	if (!s) throw new Error(`no series ${id}/${key}`);
	return s.values;
};
const checksPass = (o: ModelOutput) => expect(o.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
const close = (a: number, b: number, rel = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(a), Math.abs(b)));

const MS_DAY = 86_400_000;
const epoch = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / MS_DAY;
const iso = (e: number) => new Date(e * MS_DAY).toISOString().slice(0, 10);
/** Water-year month 0 = Oct … 11 = Sep. */
const wym = (e: number) => (new Date(e * MS_DAY).getUTCMonth() + 1 + 2) % 12;
/** Water year (Oct start) of an epoch day, by its start year. */
const wy = (e: number) => {
	const d = new Date(e * MS_DAY);
	return d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

interface HandDay {
	demand: number;
	area: number;
	rainOnDam: number;
	evap: number;
	seep: number;
	supplied: number;
	storage: number;
	spill: number;
	returnFlow: number;
	outflow: number;
	ewr: number;
	ewrShortfall: number;
}

/**
 * §2.3, §2.7, §2.7a by hand for unit A, all of the natural flow its runoff
 * (one unit), everything into the dam (100 % / 100 %, no diversion).
 */
function handRun(start: string, rain: number[], natural: number[]): HandDay[] {
	const e = 0.8;
	const beta = 0.5;
	let q = INIT * CAP;
	const out: HandDay[] = [];
	for (let t = 0; t < natural.length; t++) {
		const m = wym(epoch(start) + t);
		const apanDay = APAN[m]! / DIM[m]!;
		const demand = (CROP_M2 * APAN[m]! * KC) / 1000 / DIM[m]! / e;
		const area = q > 0 ? A_FULL * (q / CAP) ** B_EXP : 0;
		const pd = (rain[t]! * area) / 1000;
		const evap = Math.min((K_LAKE * apanDay * area) / 1000, q + pd);
		const seep = Math.min(SEEP * q, q + pd - evap);
		const s0 = q + pd - evap - seep;
		const supplied = Math.min(Math.max(s0 + natural[t]! - DEAD * CAP, 0), demand);
		const p = s0 + natural[t]! - supplied;
		const storage = Math.min(p, CAP);
		const spill = Math.max(p - CAP, 0);
		const returnFlow = beta * (1 - e) * supplied;
		const outflow = spill + returnFlow + seep;
		out.push({ demand, area, rainOnDam: pd, evap, seep, supplied, storage, spill, returnFlow, outflow, ewr: EWR[m]!, ewrShortfall: Math.min(outflow - EWR[m]!, 0) });
		q = storage;
	}
	return out;
}

const fixedRun = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));

function expectHand(o: ModelOutput, hand: HandDay[]) {
	expect(o.days).toBe(hand.length);
	const keys: [keyof HandDay, string, string | null][] = [
		['demand', 'demand', 'A'],
		['area', 'dam_area', 'A'],
		['rainOnDam', 'rain_on_dam', 'A'],
		['evap', 'dam_evaporation', 'A'],
		['seep', 'dam_seepage', 'A'],
		['supplied', 'supplied', 'A'],
		['storage', 'dam_storage', 'A'],
		['spill', 'spill', 'A'],
		['returnFlow', 'return_flow', 'A'],
		['outflow', 'outflow', 'A'],
		['ewr', 'ewr', null],
		['ewrShortfall', 'ewr_shortfall', null]
	];
	for (const [h, key, id] of keys) {
		const got = col(o, id, key);
		hand.forEach((d, t) => close(got[t]!, d[h], 1e-12));
	}
	// The gauge records what A passes.
	expect(col(o, 'G', 'outflow')).toEqual(col(o, 'A', 'outflow'));
	expect(col(o, null, 'simulated_outflow')).toEqual(col(o, 'A', 'outflow'));
}

/** Per-day farm balance, §2.7 V with §2.7a: (H + I + J + Pd) − (G − T) − E − ΔQ − U = 0. */
function expectDailyBalance(o: ModelOutput, nodeId: string, initial: number) {
	const [H, I, J, Pd, G, T, E, Q, U] = ['inflow_upstream', 'runoff', 'transfer', 'rain_on_dam', 'supplied', 'return_flow', 'dam_evaporation', 'dam_storage', 'outflow'].map((k) => col(o, nodeId, k));
	let prev = initial;
	for (let t = 0; t < o.days; t++) {
		const inn = H![t]! + I![t]! + J![t]! + Pd![t]!;
		const v = inn - (G![t]! - T![t]!) - E![t]! - (Q![t]! - prev) - U![t]!;
		expect(Math.abs(v)).toBeLessThanOrEqual(1e-9 * Math.max(1, inn, prev));
		prev = Q![t]!;
	}
}

// --- one- and two-day runs on the calendar's edges ----------------------------

const EDGES = ['2000-02-29', '2001-02-28', '2000-03-01', '2000-09-30', '2000-10-01', '2000-12-31', '2001-01-01'];

describe('one-day runs on the calendar edges match the hand balance', () => {
	for (const start of EDGES) {
		it(`a run of the single day ${start}`, () => {
			const rain = [7.5];
			const natural = [1200];
			const o = fixedRun(catchment(start, rain), natural);
			expect(o.startDate).toBe(start);
			expect(o.endDate).toBe(start);
			expectHand(o, handRun(start, rain, natural));
			expectDailyBalance(o, 'A', INIT * CAP);
			checksPass(o);

			// Summaries over the one day are that day's values (§2.8, §2.11, §2.11a).
			const hand = handRun(start, rain, natural)[0]!;
			const f = o.summary.farms.find((x) => x.nodeId === 'A')!;
			close(f.avgDemandM3Day, hand.demand);
			close(f.avgSuppliedM3Day, hand.supplied);
			expect(f.damEndM3).toBeCloseTo(hand.storage, 9);
			expect(f.damAgoM3).toBeNull();
			expect(f.damLowDate).toBe(start);
			expect(o.summary.catchment.ewrDaysNotMet).toBe(hand.ewrShortfall < 0 ? 1 : 0);
			const sa = o.summary.supplyAssurance!;
			expect([sa.reportStart, sa.reportEnd, sa.days]).toEqual([start, start, 1]);
			const r = sa.reliability.find((x) => x.nodeId === 'A')!;
			// One day can't be a complete water year (§2.11a): annual reliability is null, the part year counted.
			expect([r.waterYears, r.partWaterYears, r.annualReliability, r.demandDays]).toEqual([0, 1, null, 1]);
			// The EWR grid has the one water year and one simulated day, in that day's month (§2.9).
			const g = o.summary.ewrCompliance!;
			expect(g.waterYears).toEqual([wy(epoch(start))]);
			const days = new Array(12).fill(0);
			days[wym(epoch(start))] = 1;
			expect(g.days).toEqual([days]);
			// The water account: one row, one day, closing to float noise (§2.11b).
			const wa = sa.waterAccount;
			expect(wa.years.map((y) => [y.waterYear, y.days])).toEqual([[wy(epoch(start)), 1]]);
			expect(Math.abs(wa.total.residualM3)).toBeLessThanOrEqual(1e-10 * wa.total.scaleM3);
			close(wa.total.openingStorageM3, INIT * CAP);
			close(wa.total.closingStorageM3, hand.storage);
		});
	}
});

describe('two-day runs that cross a month, year or water-year boundary', () => {
	for (const start of EDGES) {
		it(`a run of ${start} and the day after`, () => {
			const rain = [0, 22];
			const natural = [300, 40_000];
			const o = fixedRun(catchment(start, rain), natural);
			expect(o.days).toBe(2);
			expect(o.endDate).toBe(iso(epoch(start) + 1));
			const hand = handRun(start, rain, natural);
			expectHand(o, hand);
			expectDailyBalance(o, 'A', INIT * CAP);
			checksPass(o);
			// A month change takes the next month's A-pan and EWR on day 2 (§2.3, §2.5).
			const m0 = wym(epoch(start));
			const m1 = wym(epoch(start) + 1);
			expect(col(o, null, 'ewr')).toEqual([EWR[m0], EWR[m1]]);
			// Water years: a run crossing 30 Sep → 1 Oct has two part years, everywhere they are counted.
			const years = [...new Set([wy(epoch(start)), wy(epoch(start) + 1)])];
			expect(o.summary.ewrCompliance!.waterYears).toEqual(years);
			expect(o.summary.supplyAssurance!.waterAccount.years.map((y) => y.days)).toEqual(years.length === 2 ? [1, 1] : [2]);
			const r = o.summary.supplyAssurance!.reliability.find((x) => x.nodeId === 'A')!;
			expect([r.waterYears, r.partWaterYears]).toEqual([0, years.length]);
		});
	}

	it('29 Feb and 28 Feb draw the same daily demand: §2.3 divides February by 28.25 in every year', () => {
		const leap = fixedRun(catchment('2000-02-29', [0]), [0]);
		const plain = fixedRun(catchment('2001-02-28', [0]), [0]);
		const want = (CROP_M2 * APAN[4]! * KC) / 1000 / 28.25 / 0.8;
		close(col(leap, 'A', 'demand')[0]!, want);
		close(col(plain, 'A', 'demand')[0]!, want);
		// Dam evaporation is spread over 28.25 days too (§2.3a table).
		close(col(leap, 'A', 'dam_evaporation')[0]!, (K_LAKE * (APAN[4]! / 28.25) * A_FULL * INIT ** B_EXP) / 1000);
	});
});

// --- exactly one water year ---------------------------------------------------

describe('a run of exactly one water year', () => {
	for (const y of [1999, 2000]) {
		it(`1 Oct ${y} … 30 Sep ${y + 1} (${isLeap(y + 1) ? 'leap' : 'common'} February) is one complete year everywhere`, () => {
			const n = epoch(`${y + 1}-10-01`) - epoch(`${y}-10-01`);
			const rain = Array.from({ length: n }, (_, t) => (t % 9 === 0 ? 18 : 0));
			const natural = Array.from({ length: n }, (_, t) => 600 + 500 * Math.sin(t / 20));
			const o = fixedRun(catchment(`${y}-10-01`, rain), natural);
			expect(o.days).toBe(isLeap(y + 1) ? 366 : 365);
			expectHand(o, handRun(`${y}-10-01`, rain, natural));
			expectDailyBalance(o, 'A', INIT * CAP);
			checksPass(o);
			const sa = o.summary.supplyAssurance!;
			const r = sa.reliability.find((x) => x.nodeId === 'A')!;
			expect([r.waterYears, r.partWaterYears ?? 0]).toEqual([1, 0]);
			// Annual reliability, §2.11a: the one year met when Σ G ÷ Σ D ≥ 0.9.
			const D = col(o, 'A', 'demand').reduce((a, b) => a + b, 0);
			const G = col(o, 'A', 'supplied').reduce((a, b) => a + b, 0);
			expect(r.annualReliability).toBe(G / D >= 0.9 ? 1 : 0);
			// The EWR grid's month lengths, a leap February 29 days (§2.9: a leap February is out of 29).
			expect(o.summary.ewrCompliance!.days).toEqual([[31, 30, 31, 31, isLeap(y + 1) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30]]);
			expect(sa.waterAccount.years.map((x) => [x.waterYear, x.days])).toEqual([[y, n]]);
			// One complete year to classify (§2.14).
			const cls = classifyRunWaterYears(o);
			expect(cls.years.map((x) => x.waterYear)).toEqual([y]);
			// Σ crop requirement over the year = Σ over months of area × kc × A-pan × days ÷ 28.25 for February.
			const febDays = isLeap(y + 1) ? 29 : 28;
			const want = APAN.reduce((s, a, m) => s + (CROP_M2 * a * KC) / 1000 / DIM[m]! * (m === 4 ? febDays : DIM[m]!), 0);
			close(col(o, 'A', 'crop_requirement').reduce((a, b) => a + b, 0), want, 1e-12);
		});
	}
});

// --- a report window of one day ----------------------------------------------

describe('a report window of a single day', () => {
	const n = 800;
	const rain = Array.from({ length: n }, (_, t) => (t % 7 === 0 ? 25 : t % 11 === 0 ? 4 : 0));
	const natural = Array.from({ length: n }, (_, t) => 200 + 900 * (t % 30 < 5 ? 1 : 0));
	for (const day of ['2000-02-29', '2000-09-30', '2000-10-01', '2001-01-01', '1999-10-01', '2001-12-08']) {
		it(`reportStart = reportEnd = ${day}: every windowed summary is that day's values`, () => {
			const o = fixedRun(catchment('1999-10-01', rain, { reportStart: day, reportEnd: day }), natural);
			checksPass(o);
			const t = epoch(day) - epoch('1999-10-01');
			const D = col(o, 'A', 'demand')[t]!;
			const G = col(o, 'A', 'supplied')[t]!;
			const c = o.summary.curtailment!;
			expect([c.reportStart, c.reportEnd, c.days]).toEqual([day, day, 1]);
			const cf = c.farms.find((x) => x.nodeId === 'A')!;
			close(cf.demandM3Day, D);
			close(cf.suppliedM3Day, G);
			close(cf.deficitM3Day, G - D);
			// One farm: the equitable share is its own fraction, so it neither reduces nor gains (§2.11 N = M − I).
			close(c.equitableFraction ?? NaN, G / D);
			close(cf.reduceGainM3Day, 0);
			const sa = o.summary.supplyAssurance!;
			expect([sa.reportStart, sa.reportEnd, sa.days]).toEqual([day, day, 1]);
			const r = sa.reliability.find((x) => x.nodeId === 'A')!;
			const met = D - G <= 1e-9 * D;
			expect([r.demandDays, r.metDays, r.failureRuns, r.longestFailureDays, r.waterYears, r.partWaterYears]).toEqual([1, met ? 1 : 0, met ? 0 : 1, met ? 0 : 1, 0, 1]);
			close(r.demandM3, D);
			close(r.suppliedM3, G);
			expect(r.months.map((x) => x.demandDays)).toEqual(Array.from({ length: 12 }, (_, m) => (m === wym(epoch(day)) ? 1 : 0)));
			// The whole-run summaries ignore the report window (§2.8: farms keep the whole-run averages).
			const f = o.summary.farms.find((x) => x.nodeId === 'A')!;
			close(f.avgDemandM3Day, col(o, 'A', 'demand').reduce((a, b) => a + b, 0) / n);
		});
	}
});

// --- the run window against the series it reads ---------------------------------

describe('a run window that reaches past its series', () => {
	const rainVals = Array.from({ length: 200 }, (_, t) => (t % 5 === 0 ? 30 : t % 3 === 0 ? 2 : 0));

	it('rain that starts after the run start and ends before its end: the outside days run dry, are NaN in rain_final and are counted', () => {
		const i = catchment('2001-03-01', rainVals, { runoffModel: 'gr4j', simulationStart: '2000-10-01', simulationEnd: '2001-12-31' });
		const o = runModelChecked(i);
		checksPass(o);
		expect([o.startDate, o.endDate]).toEqual(['2000-10-01', '2001-12-31']);
		const n = epoch('2001-12-31') - epoch('2000-10-01') + 1;
		expect(o.days).toBe(n);
		const lead = epoch('2001-03-01') - epoch('2000-10-01');
		const rf = col(o, null, 'rain_final');
		const used = col(o, null, 'rain_used');
		for (let t = 0; t < n; t++) {
			const inside = t >= lead && t < lead + 200;
			if (inside) expect(rf[t]).toBe(rainVals[t - lead]);
			else {
				expect(rf[t]).toBeNaN();
				expect(used[t]).toBe(0);
			}
		}
		const outside = n - 200;
		expect(o.summary.warnings.some((w) => w.startsWith(`${outside} of ${n} days have no rainfall value`))).toBe(true);
		// GR4J keeps its balance across the dry padding (§2.4a), and no store goes negative.
		for (const k of ['production_store', 'routing_store', 'uh_store', 'natural_flow']) expect(Math.min(...col(o, null, k))).toBeGreaterThanOrEqual(0);
	});

	it('leading and trailing blanks with no window set: the run covers the first to the last rain value (§2.1)', () => {
		const vals = [null, null, null, ...rainVals, null, null];
		const o = runModelChecked(catchment('2000-12-29', vals, { runoffModel: 'gr4j' }));
		checksPass(o);
		expect(o.startDate).toBe('2001-01-01');
		expect(o.days).toBe(200);
		expect(col(o, null, 'rain_final')).toEqual(rainVals);
	});

	it('an observed flow record shorter than the run: missing days are NaN and calibration scores only the overlap', () => {
		const flow = Array.from({ length: 60 }, (_, t) => 0.01 + 0.002 * (t % 4));
		const i = catchment('2001-01-01', rainVals, { runoffModel: 'gr4j', calibrationFlowKind: 'flow_observed_m3s' }, { flow_observed_m3s: { startDate: '2000-12-01', values: [...flow, ...new Array(20).fill(null), ...flow] } });
		const o = runModelChecked(i);
		checksPass(o);
		const obs = col(o, null, 'observed_flow');
		expect(obs.length).toBe(200);
		// The record covers 2000-12-01 … 2001-04-20 with a 20-day gap: run days 0–29 (Jan), then the gap, then 60 more.
		const want = Array.from({ length: 200 }, (_, t) => {
			const k = t + 31; // record index of run day t
			if (k < 60) return flow[k]! * 86_400;
			if (k < 80) return NaN;
			if (k < 140) return flow[k - 80]! * 86_400;
			return NaN;
		});
		obs.forEach((v, t) => (Number.isNaN(want[t]!) ? expect(v).toBeNaN() : close(v, want[t]!)));
		const cal = o.summary.calibration!;
		expect(cal.days).toBe(want.filter((v) => !Number.isNaN(v)).length);
		expect(cal.firstObservedDate).toBe('2001-01-01');
		expect(cal.lastObservedDate).toBe(iso(epoch('2001-01-01') + 108));
		// The mean observed flow is the mean of the scored days only.
		const scored = want.filter((v) => !Number.isNaN(v)).map((v) => v / 86_400);
		close(cal.meanObservedM3s!, scored.reduce((a, b) => a + b, 0) / scored.length, 1e-12);
	});

	it('a daily A-pan record covering part of the run: its days use it, the rest the monthly mean ÷ days in month (§2.3a)', () => {
		const apanDaily = [5, 6, null, -1, 7.5, 0];
		// The daily record starts 2 days into a 10-day run (2001-01-30 … 2001-02-08).
		const i = catchment('2001-01-30', new Array(10).fill(0), {}, { evap_apan_mm: { startDate: '2001-02-01', values: apanDaily } });
		const o = fixedRun(i, new Array(10).fill(0));
		checksPass(o);
		const D = col(o, 'A', 'demand');
		for (let t = 0; t < 10; t++) {
			const m = wym(epoch('2001-01-30') + t);
			const k = t - 2;
			const v = k >= 0 && k < apanDaily.length ? apanDaily[k] : null;
			const apanDay = v !== null && v !== undefined && v >= 0 ? v : APAN[m]! / DIM[m]!;
			close(D[t]!, (CROP_M2 * KC * apanDay) / 1000 / 0.8);
		}
		const s = o.summary.apanDaily!;
		// Supplied: 5, 6, 7.5, 0 (four days ≥ 0); fallback: the 2 days before, the blank, the negative and the 2 after.
		expect([s.dailyDays, s.fallbackDays, s.invalidDays]).toEqual([4, 6, 1]);
	});
});

describe('runs whose rain is all missing, or whose window has no rain value', () => {
	it('every rain day missing inside an explicit window: the run is dry, every value finite, the checks pass', () => {
		const o = runModelChecked(catchment('2000-06-01', new Array(100).fill(null), { runoffModel: 'gr4j', simulationStart: '2000-06-01', simulationEnd: '2000-09-08' }));
		checksPass(o);
		expect(o.days).toBe(100);
		expect(col(o, null, 'rain_used')).toEqual(new Array(100).fill(0));
		expect(col(o, null, 'rain_final').every(Number.isNaN)).toBe(true);
		expect(o.summary.warnings.some((w) => w.startsWith('100 of 100 days have no rainfall value'))).toBe(true);
		for (const s of o.series) if (!['rain_final', 'rain_source'].includes(s.key)) expect(s.values.every(Number.isFinite), s.key).toBe(true);
		// With no rain the runoff coefficient is undefined (§2.4: null without rain).
		expect(o.summary.catchment.runoffCoefficient ?? null).toBeNull();
	});

	it('no series at all and no window: the run refuses with a reason rather than inventing a period', () => {
		const i = catchment('2000-01-01', []);
		i.series = {};
		expect(() => runModel(i)).toThrow(/no rainfall series/);
	});
});
