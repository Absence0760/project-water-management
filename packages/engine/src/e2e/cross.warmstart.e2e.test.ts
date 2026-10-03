// End-to-end, round 2: warm starts (docs/model.md §2.16) where features meet.
// runModelFrom(captureModelState(x, d), x) must equal the days d … end of
// the uninterrupted runModelWithoutChecks(x) to the bit, on an invented
// catchment that has, all at once, a forecast tail (§2.4f) that crosses
// 1 October, a drought restriction rule with an EWR trigger (§2.7i), a dam
// that comes into service on 29 February (§2.7g), a storage reset (§2.15a),
// a river off-take to a canal town (§2.6a), a dam transfer (§2.6) and
// allocations (§2.12a, cap and full allocation). Split days: the first
// forecast day, a day inside the tail, the tail's 1 October, a day held
// inside a restriction, a review day, the in-service day, the day before
// it, the reset's day and the day after. Also: the forecast tail leaves
// every historical day as the run without it has it (§2.4f, causal),
// with all those features on. Synthetic values only.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { DemandObject, DroughtRestrictionRule, ModelInput, ModelOutput, NetworkNode, Transfer } from '../project';
import type { AllocationEntry } from '../allocations/compare';
import { captureModelState, runModelFrom, runModelWithoutChecks } from '../run';
import { forecastSplit, withoutForecastTail } from '../forecast';
import { testCatchment } from '../outlook/testCatchment';

/**
 * The first difference between the resumed run and the uninterrupted run's days from k, or null.
 */
function tailDiff(full: ModelOutput, resumed: ModelOutput, k: number): string | null {
	if (resumed.startDate !== fromEpochDay(toEpochDay(full.startDate) + k)) return `starts ${resumed.startDate}`;
	if (resumed.days !== full.days - k) return `${resumed.days} days, expected ${full.days - k}`;
	const fk = full.series.map((s) => `${s.nodeId}:${s.key}`).join('|');
	const rk = resumed.series.map((s) => `${s.nodeId}:${s.key}`).join('|');
	if (fk !== rk) return `series keys differ:\n${fk}\n${rk}`;
	for (let i = 0; i < full.series.length; i++) {
		const a = full.series[i]!;
		const b = resumed.series[i]!;
		for (let t = 0; t < b.values.length; t++) if (!Object.is(a.values[t + k], b.values[t])) return `${a.nodeId}:${a.key} on ${fromEpochDay(toEpochDay(resumed.startDate) + t)}: ${a.values[t + k]} vs ${b.values[t]}`;
	}
	return null;
}

const HISTORY_END = '2006-03-31';
const TAIL_END = '2006-10-20';
const RESET = '2005-06-15';
const IN_SERVICE = '2004-02-29';

function base(mode: 'none' | 'cap' | 'fullAllocation'): ModelInput {
	const x = testCatchment({ start: '2002-10-01', end: HISTORY_END, seed: 23, ewrM3Day: 700 });
	const town: DemandObject = {
		id: 'ct',
		nodeId: 'c',
		name: 'Canal town',
		category: 'municipal',
		sizing: 'monthly',
		monthlyM3Day: new Array(12).fill(150),
		count: null,
		litresPerUnitDay: null,
		lossPct: 0,
		monthlyFactor: null,
		returnPct: 0.3,
		priority: 'first',
		destination: 'internal',
		enabled: true,
		note: '',
		population: 4000
	};
	const canal: NetworkNode = { ...x.model.nodes[1]!, id: 'c', name: 'Canal head', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, damCapacityM3: 0, damInitialPct: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0, damAreaFullM2: null, sortOrder: 3, downstreamNodeId: 'g' };
	const transfers: Transfer[] = [
		{ id: 'ot', fromNodeId: 'a', toNodeId: 'c', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 0.01, dailyCapM3: 400, minStoragePct: 0, enabled: true, priority: 0, source: 'river', sizing: 'demand', lossPct: 0.1, lossReturnPct: 0.5, handsOffM3Day: 200, handsOffEwr: false, topUpDam: false },
		{ id: 'tr', fromNodeId: 'a', toNodeId: 'b', months: [11, 12, 1, 2], maxRateM3s: 0.005, dailyCapM3: null, minStoragePct: 0.3, enabled: true, priority: 1 }
	];
	const rule: DroughtRestrictionRule = {
		reviewDates: ['10-01', '01-01', '04-01', '07-01'],
		liftDates: ['05-01'],
		levels: [
			{ label: 'L1', belowPct: 0.6, cuts: { crops: 0.3 } },
			{ label: 'L2', belowPct: 0.35, cuts: { crops: 0.6, municipal: 0.5 } }
		],
		ewrTrigger: { siteNodeId: null, level: 1 }
	};
	const allocations: AllocationEntry[] = [
		{ id: 'a1', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 220_000 },
		{ id: 'b1', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: 90_000, validFrom: '2004-02-29' },
		{ id: 'c1', nodeId: 'c', waterSource: 'surface', volumeM3PerYear: 60_000 }
	];
	// Forecast rain from the day after the record to TAIL_END: a shower every fifth day, wetter in winter.
	const f0 = toEpochDay(HISTORY_END) + 1;
	const n = toEpochDay(TAIL_END) - f0 + 1;
	const forecast = Array.from({ length: n }, (_, i) => {
		const m = new Date((f0 + i) * 86_400_000).getUTCMonth() + 1;
		return i % 5 === 0 ? (m >= 5 && m <= 9 ? 14 : 4) : 0;
	});
	return {
		...x,
		settings: { ...x.settings, droughtRestriction: rule, allocationMode: mode, damStorageReset: { date: RESET, storageM3: { a: 60_000, b: 20_000 } } },
		model: {
			...x.model,
			nodes: [...x.model.nodes.map((nd) => (nd.id === 'b' ? { ...nd, damInServiceFrom: IN_SERVICE } : nd)), canal],
			transfers,
			demandObjects: [town],
			allocations
		},
		series: { ...x.series, rain_forecast_mm: { startDate: fromEpochDay(f0), values: forecast } }
	};
}

function splitDays(full: ModelOutput): Map<string, number> {
	const d0 = toEpochDay(full.startDate);
	const at = (iso: string) => toEpochDay(iso) - d0;
	const ks = new Map<string, number>([
		['the first forecast day', at('2006-04-01')],
		['inside the tail', at('2006-06-17')],
		['the tail’s 1 October', at('2006-10-01')],
		['the tail’s last day', at(TAIL_END)],
		['the day before the dam’s in-service day', at('2004-02-28')],
		['the dam’s in-service day (29 Feb)', at(IN_SERVICE)],
		['the storage reset’s day', at(RESET)],
		['the day after the reset', at(RESET) + 1],
		['a review day', at('2005-01-01')],
		['the lift day', at('2005-05-01')]
	]);
	// A day held inside a restriction (level > 0 the day before and on the day, not a review or lift day).
	const lv = full.series.find((s) => s.nodeId === null && s.key === 'restriction_level')!.values;
	const held = lv.findIndex((v, t) => t > 30 && v > 0 && lv[t - 1]! > 0 && lv[t - 1] === v && !['10-01', '01-01', '04-01', '07-01', '05-01'].includes(fromEpochDay(d0 + t).slice(5)));
	expect(held, 'some day is held inside a restriction').toBeGreaterThan(0);
	ks.set('inside a restriction', held);
	return ks;
}

describe('a resumed run is the uninterrupted run’s tail where features meet (§2.16)', () => {
	for (const mode of ['fullAllocation', 'cap', 'none'] as const) {
		it(`allocation mode ${mode}: forecast tail, restriction, in-service dam, storage reset, off-take, transfer`, () => {
			const input = base(mode);
			const full = runModelWithoutChecks(input);
			expect(full.forecastFrom ?? forecastSplit(input).forecastFrom).toBe('2006-04-01');
			// The rule did restrict somewhere, and the dam really comes in on 29 February.
			const cap = full.series.find((s) => s.nodeId === 'b' && s.key === 'dam_capacity')!.values;
			const d0 = toEpochDay(full.startDate);
			expect(cap[toEpochDay(IN_SERVICE) - d0 - 1]).toBe(0);
			expect(cap[toEpochDay(IN_SERVICE) - d0]).toBe(150_000);
			const problems: string[] = [];
			for (const [name, k] of splitDays(full)) {
				const at = fromEpochDay(d0 + k);
				const snap = JSON.parse(JSON.stringify(captureModelState(input, at)));
				const d = tailDiff(full, runModelFrom(snap, input), k);
				if (d) problems.push(`${name} (${at}): ${d}`);
			}
			expect(problems).toEqual([]);
		});
	}

	it('full allocation: the year the tail starts in keeps its historical factor on its tail days; the tail’s new year is fitted on its tail days', () => {
		const input = base('fullAllocation');
		const full = runModelWithoutChecks(input);
		const d0 = toEpochDay(full.startDate);
		const k = full.series.find((s) => s.nodeId === 'a' && s.key === 'allocation_demand_factor')!.values;
		const dem = full.series.find((s) => s.nodeId === 'a' && s.key === 'demand')!.values;
		const at = (iso: string) => toEpochDay(iso) - d0;
		// 2005/06: one factor from 1 Oct 2005 to 30 Sep 2006, and the demand over its historical days
		// (to 31 Mar 2006) is the volume registered over them.
		const k05 = k[at('2005-10-01')]!;
		for (let t = at('2005-10-01'); t <= at('2006-09-30'); t++) expect(k[t]).toBe(k05);
		let D = 0;
		for (let t = at('2005-10-01'); t <= at(HISTORY_END); t++) D += dem[t]!;
		const wy = toEpochDay('2006-10-01') - toEpochDay('2005-10-01');
		expect(D).toBeCloseTo((220_000 * (at(HISTORY_END) - at('2005-10-01') + 1)) / wy, 4);
		// 2006/07 lies wholly in the tail: fitted over its 20 tail days.
		let D2 = 0;
		for (let t = at('2006-10-01'); t <= at(TAIL_END); t++) D2 += dem[t]!;
		const wy2 = toEpochDay('2007-10-01') - toEpochDay('2006-10-01');
		if (D2 > 0) expect(D2).toBeCloseTo((220_000 * 20) / wy2, 4);
	});

	it('the forecast tail changes no historical day (§2.4f causal), with all these features on', () => {
		for (const mode of ['fullAllocation', 'cap'] as const) {
			const input = base(mode);
			const withTail = runModelWithoutChecks(input);
			const without = runModelWithoutChecks(withoutForecastTail(input));
			expect(without.endDate).toBe(HISTORY_END);
			const bad: string[] = [];
			for (const s of without.series) {
				const w = withTail.series.find((x) => x.nodeId === s.nodeId && x.key === s.key);
				if (!w) {
					bad.push(`${s.nodeId}:${s.key} missing with the tail`);
					continue;
				}
				const t = s.values.findIndex((v, i) => !Object.is(v, w.values[i]));
				if (t >= 0) bad.push(`${mode} ${s.nodeId}:${s.key} day ${fromEpochDay(toEpochDay(without.startDate) + t)}: ${s.values[t]} vs ${w.values[t]}`);
			}
			expect(bad.slice(0, 10)).toEqual([]);
		}
	});
});
