// End-to-end: warm starts (docs/model.md §2.16). runModelFrom(
// captureModelState(x, d), x) must equal, to the bit, the days d … end of
// runModelWithoutChecks(x), for many split days d: the first day, the last,
// the day after the last, 29 February, 1 March, 30 September, 1 October and
// mid-month, on synthetic inputs with allocations (cap and full allocation),
// the drought restriction rule, storage resets and random networks. The
// comparison is written here (Object.is per value, the same keys in the same
// order), not taken from ../testing/warmstartInvariants. Also: the resumed
// run's summary covers the resumed days only (§2.16), checked by hand.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput } from '../project';
import { captureModelState, runModelFrom, runModelWithoutChecks } from '../run';
import { testCatchment } from '../outlook/testCatchment';
import { randomInput } from '../testing';

/** The first difference between the resumed run and the uninterrupted run's tail from day k, or null. */
function tailDiff(full: ModelOutput, resumed: ModelOutput, k: number): string | null {
	if (resumed.startDate !== fromEpochDay(toEpochDay(full.startDate) + k)) return `starts ${resumed.startDate}`;
	if (resumed.days !== full.days - k) return `${resumed.days} days, expected ${full.days - k}`;
	const fk = full.series.map((s) => `${s.nodeId}:${s.key}`);
	const rk = resumed.series.map((s) => `${s.nodeId}:${s.key}`);
	if (fk.join('|') !== rk.join('|')) {
		const missing = fk.filter((x) => !rk.includes(x));
		const extra = rk.filter((x) => !fk.includes(x));
		return `series keys differ: missing ${missing.join(',') || '-'}; extra ${extra.join(',') || '-'}; or order`;
	}
	for (let i = 0; i < full.series.length; i++) {
		const a = full.series[i]!;
		const b = resumed.series[i]!;
		if (a.label !== b.label || a.unit !== b.unit) return `${a.nodeId}:${a.key} label/unit`;
		for (let t = 0; t < b.values.length; t++) {
			if (!Object.is(a.values[t + k], b.values[t])) return `${a.nodeId}:${a.key} on ${fromEpochDay(toEpochDay(resumed.startDate) + t)}: ${a.values[t + k]} vs ${b.values[t]}`;
		}
	}
	return null;
}

/** The split days for a run: first, last, day after last, every 29 Feb / 1 Mar / 30 Sep / 1 Oct (up to 2 each), and a mid-month day. */
function splitDays(out: ModelOutput): number[] {
	const d0 = toEpochDay(out.startDate);
	const ks = new Set<number>([0, out.days - 1, out.days, Math.floor(out.days / 2)]);
	const want = ['-02-29', '-03-01', '-09-30', '-10-01'];
	const seen = new Map<string, number>();
	for (let t = 1; t < out.days; t++) {
		const iso = fromEpochDay(d0 + t);
		for (const w of want)
			if (iso.endsWith(w) && (seen.get(w) ?? 0) < 2) {
				ks.add(t);
				seen.set(w, (seen.get(w) ?? 0) + 1);
			}
	}
	return [...ks].filter((k) => k >= 0 && k <= out.days).sort((a, b) => a - b);
}

function resumeEverywhere(input: ModelInput): string[] {
	const full = runModelWithoutChecks(input);
	const problems: string[] = [];
	for (const k of splitDays(full)) {
		const at = fromEpochDay(toEpochDay(full.startDate) + k);
		const snap = JSON.parse(JSON.stringify(captureModelState(input, at)));
		if (k === full.days) {
			// The day after the last: nothing left to run (the window would end before the snapshot's day).
			continue;
		}
		const resumed = runModelFrom(snap, input);
		const d = tailDiff(full, resumed, k);
		if (d) problems.push(`${at}: ${d}`);
	}
	return problems;
}

const BASE = testCatchment({ start: '2002-10-01', end: '2009-09-30', seed: 21, ewrM3Day: 600 });

function withAllocations(mode: 'cap' | 'fullAllocation', conditions = false): ModelInput {
	return {
		...BASE,
		settings: { ...BASE.settings, allocationMode: mode },
		model: {
			...BASE.model,
			allocations: [
				// A volume below what Farm A asks, so the cap binds in most years (its mean demand is ~1 700 m³/day).
				{ id: 'al1', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 250_000, ...(conditions ? { months: [10, 11, 12, 1, 2, 3], maxRateM3s: 0.02 } : {}) },
				// One that starts mid-year and ends mid-year: prorated.
				{ id: 'al2', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: 120_000, validFrom: '2004-02-29', validTo: '2008-03-01' }
			]
		}
	};
}

describe('outputs e2e: a resumed run is the uninterrupted run’s tail (§2.16)', () => {
	const cases: [string, () => ModelInput][] = [
		['the plain catchment', () => BASE],
		['land cover and a Reserve rule table (pinned record-wide statistics)', () => testCatchment({ start: '2002-10-01', end: '2009-09-30', seed: 21, recordWide: true, dailyApan: true })],
		['an allocation cap', () => withAllocations('cap')],
		['an allocation cap with months of use and a rate', () => withAllocations('cap', true)],
		['a full allocation', () => withAllocations('fullAllocation')],
		['a storage reset on 1 Jan 2006', () => ({ ...BASE, settings: { ...BASE.settings, damStorageReset: { date: '2006-01-01', storageM3: { a: 10_000, b: 140_000 } } } })],
		['a demand factor from 1 Oct 2005', () => ({
			...BASE,
			settings: { ...BASE.settings, demandFactorFrom: '2005-10-01' },
			model: { ...BASE.model, nodes: BASE.model.nodes.map((n) => (n.id === 'a' ? { ...n, demandFactor: new Array(12).fill(0.7) } : n)) }
		})]
	];
	for (const [name, make] of cases) {
		it(name, () => {
			expect(resumeEverywhere(make())).toEqual([]);
		});
	}
	it('random networks (transfers, users, boreholes, allocations, restriction rules, …)', () => {
		const problems: string[] = [];
		let n = 0;
		for (let seed = 4400; seed < 4430; seed++) {
			const input = randomInput(seed, { maxNodes: 6, maxDays: 800 });
			try {
				runModelWithoutChecks(input);
			} catch {
				continue;
			}
			n++;
			for (const p of resumeEverywhere(input)) problems.push(`seed ${seed} ${p}`);
		}
		expect(n).toBeGreaterThan(15);
		expect(problems).toEqual([]);
	});
});

describe('outputs e2e: what a resumed run reports (§2.16)', () => {
	it('an input with no history before the snapshot’s day (its series start on the day) resumes the same', () => {
		const full = runModelWithoutChecks(BASE);
		for (const at of ['2004-02-29', '2006-10-01', '2008-03-01']) {
			const k = toEpochDay(at) - toEpochDay(full.startDate);
			const rain = BASE.series.rain_catchment_mm!;
			const seasonOnly: ModelInput = { ...BASE, series: { rain_catchment_mm: { startDate: at, values: rain.values.slice(k) } } };
			const resumed = runModelFrom(captureModelState(BASE, at), seasonOnly);
			expect(tailDiff(full, resumed, k), at).toBeNull();
		}
	});

	it('the summary covers the resumed days only: farm means, the curtailment window and the EWR days', () => {
		const input = { ...BASE, settings: { ...BASE.settings, reportStart: '2003-01-01', reportEnd: '2007-06-30' } };
		const full = runModelWithoutChecks(input);
		const at = '2004-02-29';
		const k = toEpochDay(at) - toEpochDay(full.startDate);
		const resumed = runModelFrom(captureModelState(input, at), input);
		const col = (o: ModelOutput, n: string | null, key: string) => o.series.find((s) => s.nodeId === n && s.key === key)!.values;
		const meanOf = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
		for (const f of resumed.summary.farms) expect(f.avgSuppliedM3Day).toBeCloseTo(meanOf(col(full, f.nodeId, 'supplied').slice(k)), 9);
		// The reporting window is clipped to the resumed days: 29 Feb 2004 … 30 Jun 2007.
		const c = resumed.summary.curtailment!;
		expect([c.reportStart, c.reportEnd]).toEqual(['2004-02-29', '2007-06-30']);
		const to = toEpochDay('2007-06-30') - toEpochDay(full.startDate);
		for (const f of c.farms) expect(f.demandM3Day).toBeCloseTo(meanOf(col(full, f.nodeId, 'demand').slice(k, to + 1)), 9);
		expect(resumed.summary.catchment.ewrDaysNotMet).toBe(col(full, null, 'ewr_shortfall').slice(k).filter((v) => v < 0).length);
	});
});
