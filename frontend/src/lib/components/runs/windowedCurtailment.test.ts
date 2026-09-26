// The browser's re-windowed curtailment table must be the engine's own table
// for the same window: a synthetic run (the engine's seeded generator) is run
// once, its stored series re-windowed here, and compared with runModel run
// again with that window as the project setting. Only the EWR site setting a
// farm's charge differs, and only over a window other than the run's own.
import { runModel, toEpochDay, type ModelInput, type ModelOutput } from '@water-management/engine';
import { randomInput } from '@water-management/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { consumptiveShare, curtailmentSeriesKeys, missingSeries, recomputeCurtailment } from './windowedCurtailment';
import { resolveWindow, type WindowChoice } from './reportWindow';

/** The run's series as the API stores them: a non-finite day is null. */
function storedLookup(out: ModelOutput) {
	const m = new Map(out.series.map((s) => [`${s.nodeId ?? ''}|${s.key}`, s.values.map((v) => (Number.isFinite(v) ? v : null))]));
	return (nodeId: string | null, key: string) => {
		const v = m.get(`${nodeId ?? ''}|${key}`);
		if (!v) throw new Error(`no ${key} series for ${nodeId}`);
		return v;
	};
}

function withWindow(input: ModelInput, start: string | null, end: string | null): ModelInput {
	return { ...input, settings: { ...input.settings, reportStart: start, reportEnd: end } };
}

/** Seeds whose run has farms (and so a curtailment table with rows). */
function runs(count: number) {
	const out: { input: ModelInput; run: ModelOutput }[] = [];
	for (let seed = 1; out.length < count && seed < 400; seed++) {
		const input = randomInput(seed, { maxDays: 400 });
		let run: ModelOutput;
		try {
			run = runModel(input);
		} catch {
			continue;
		}
		if (run.summary.curtailment?.farms.length && run.days >= 40) out.push({ input, run });
	}
	return out;
}

const cases = runs(12);
const noBinding = <T extends { farms: { ewrBindingSiteId?: string | null }[] }>(c: T): T => ({ ...c, farms: c.farms.map((f) => ({ ...f, ewrBindingSiteId: null })) });

describe('recomputeCurtailment', () => {
	it('has synthetic runs to check, some with other water users and several EWR sites', () => {
		expect(cases.length).toBe(12);
		expect(cases.some((c) => c.run.summary.curtailment!.otherUsers?.length)).toBe(true);
		expect(cases.some((c) => (c.run.summary.curtailment!.ewrSites?.length ?? 0) > 1)).toBe(true);
	});

	it('equals the engine’s own table over the run’s window, binding sites included', () => {
		for (const { input, run } of cases) {
			const stored = run.summary.curtailment!;
			const own = { from: toEpochDay(stored.reportStart) - toEpochDay(run.startDate), to: toEpochDay(stored.reportEnd) - toEpochDay(run.startDate), reportStart: stored.reportStart, reportEnd: stored.reportEnd };
			const r = recomputeCurtailment(stored, storedLookup(run), input.model.nodes, own);
			expect(r.curtailment).toEqual(stored);
			expect(r.bindingKnown).toBe(true);
		}
	});

	it('equals runModel with the picked window as the project setting, for every preset', () => {
		const choices: WindowChoice[] = [{ preset: 'last7' }, { preset: 'last30' }, { preset: 'all' }, { preset: 'custom', start: '1900-01-01', end: '2999-12-31' }];
		for (const { input, run } of cases) {
			const stored = run.summary.curtailment!;
			const mid = { preset: 'custom' as const, start: run.startDate, end: run.endDate };
			for (const choice of [...choices, mid]) {
				const res = resolveWindow(choice, run, stored);
				if (!res.ok) throw new Error(res.error);
				const w = res.window;
				const again = runModel(withWindow(input, w.reportStart, w.reportEnd)).summary.curtailment!;
				const r = recomputeCurtailment(stored, storedLookup(run), input.model.nodes, w);
				expect(noBinding(r.curtailment)).toEqual(noBinding(again));
				if (w.reportStart === stored.reportStart && w.reportEnd === stored.reportEnd) expect(r.curtailment).toEqual(stored);
				// Unknown binding only matters when some farm carries a charge.
				if (!r.bindingKnown) expect(r.curtailment.farms.some((f) => f.ewrShortfallM3Day < 0)).toBe(true);
			}
		}
	});

	it('lists every series it reads, and the run stores each of them', () => {
		for (const { run } of cases) {
			const keys = curtailmentSeriesKeys(run.summary.curtailment!)!;
			const c = run.summary.curtailment!;
			expect(keys).toHaveLength(4 * c.farms.length + 4 * (c.otherUsers?.length ?? 0) + 3 * (c.ewrSites?.length ?? 0));
			expect(missingSeries(keys, run.series)).toEqual([]);
			// The outlet's series are the catchment's.
			if (c.ewrSites?.[0]?.isOutlet) expect(keys).toContainEqual({ nodeId: null, key: 'ewr_charged' });
		}
	});

	it('says a run saved before the EWR charge cannot be re-windowed', () => {
		const c = cases[0]!.run.summary.curtailment!;
		expect(curtailmentSeriesKeys({ ...c, ewrAttribution: undefined })).toBeNull();
		expect(missingSeries([{ nodeId: 'a', key: 'demand' }, { nodeId: null, key: 'ewr_charged' }], [{ nodeId: null, key: 'ewr_charged' }])).toEqual([{ nodeId: 'a', key: 'demand' }]);
	});

	it('clamps k as runModel does', () => {
		expect(consumptiveShare({ id: 'f', kind: 'farm', irrigationEfficiency: 0.8, lossReturnFraction: 0.5 })).toBeCloseTo(0.9, 12);
		expect(consumptiveShare({ id: 'f', kind: 'farm', irrigationEfficiency: 0, lossReturnFraction: 2 })).toBe(1);
		expect(consumptiveShare({ id: 'u', kind: 'user', userReturnPct: 1.5 })).toBe(0);
		expect(consumptiveShare({ id: 'u', kind: 'user', userReturnPct: null })).toBe(1);
		expect(consumptiveShare(undefined)).toBe(1);
	});

	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('averages over the same days east and west of UTC', () => {
			const { input, run } = cases[0]!;
			const stored = run.summary.curtailment!;
			const expected = (() => {
				const res = resolveWindow({ preset: 'last7' }, run, stored);
				if (!res.ok) throw new Error(res.error);
				return recomputeCurtailment(stored, storedLookup(run), input.model.nodes, res.window).curtailment;
			})();
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Johannesburg']) {
				process.env.TZ = zone;
				const res = resolveWindow({ preset: 'last7' }, run, stored);
				if (!res.ok) throw new Error(res.error);
				expect(recomputeCurtailment(stored, storedLookup(run), input.model.nodes, res.window).curtailment, zone).toEqual(expected);
			}
		});
	});
});
