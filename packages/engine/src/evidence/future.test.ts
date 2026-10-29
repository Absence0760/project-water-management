// § 8, Future yield (issue #621 slice 4, evidence-23; evidence/future.ts):
// the factor table from cells, the pairs run under each case's climate.delta
// op, the ranges across models, the re-check reproduce:pack runs, and the
// caveat's guard. Synthetic catchment (testing/packBundle.ts) and invented
// factors: no real model, place or value.
import { describe, expect, it } from 'vitest';
import type { ModelInput } from '../project';
import { applyScenario } from '../scenario/overrides';
import type { ClimateYear } from '../scenario/climate';
import { firmYield } from '../network/yield';
import { runModel } from '../run';
import { FUTURE_FIXTURE_DAM, fixtureFactorTable, packFixtureInput } from '../testing/packBundle';
import { ENGINE_VERSION } from '../version';
import {
	buildFutureFactorTable,
	checkFutureYield,
	FUTURE_MIN_MODELS,
	FUTURE_YIELD_CAVEAT,
	futureCaseOp,
	futureCaveatPending,
	futureDamError,
	futureFactorsComplete,
	futureFactorTableError,
	futureRange,
	futureYieldSteps,
	runFutureYield,
	runFutureYieldAsync,
	type FutureFactorTable,
	type FutureYieldCaveat
} from './future';

/** The fixture's two inputs: Farm one with a dam, the application doubling its maize. */
function inputs(): { baseline: ModelInput; application: ModelInput } {
	const baseline = packFixtureInput();
	baseline.model.nodes = baseline.model.nodes.map((n) => (n.id === 'F1' ? { ...n, ...FUTURE_FIXTURE_DAM } : n));
	const application: ModelInput = { ...baseline, model: { ...baseline.model, cropAreas: baseline.model.cropAreas.map((a) => ({ ...a, areaM2: 600_000 })) } };
	return { baseline, application };
}
const run = (factors: FutureFactorTable = fixtureFactorTable()) => runFutureYield({ ...inputs(), nodeId: 'F1', ownedNodeIds: ['F1'], factors });
/** A table of one model whose every factor is `rain` (rain) and `evap` (evaporation). */
const flat = (rain: number, evap = 1): FutureFactorTable => {
	const t = fixtureFactorTable(1);
	return { ...t, cases: t.cases.map((c) => ({ ...c, rainFactorByMonth: new Array(12).fill(rain), evapFactorByMonth: new Array(12).fill(evap) })) };
};

describe('the ranges across models', () => {
	it('gives the median, smallest and largest of the numbers, ignoring the rest', () => {
		expect(futureRange([3, 1, 2])).toEqual({ n: 3, median: 2, min: 1, max: 3 });
		expect(futureRange([4, null, 1, 2, 3])).toEqual({ n: 4, median: 2.5, min: 1, max: 4 });
		expect(futureRange([null, Number.NaN])).toEqual({ n: 0, median: null, min: null, max: null });
	});
});

describe('runFutureYield', () => {
	const r = run();

	it('measures the historical pair as the record gives it, with no op', () => {
		const { baseline, application } = inputs();
		const ob = runModel(structuredClone(baseline));
		const oa = runModel(structuredClone(application));
		expect(r.historical.ewrDaysBaseline).toBe(ob.summary.catchment.ewrDaysNotMet);
		expect(r.historical.ewrDaysApplication).toBe(oa.summary.catchment.ewrDaysNotMet);
		expect(r.historical.ewrDaysChange).toBe(oa.summary.catchment.ewrDaysNotMet - ob.summary.catchment.ewrDaysNotMet);
		expect(r.historical.firmYieldM3Year).toBe(firmYield(application, 'F1').yieldM3Year);
		expect(r.historical.yieldAtAssuranceM3Year).toBe(firmYield(application, 'F1', { assurance: 0.98 }).yieldM3Year);
		// The yield at 98 % is never below the firm yield.
		expect(r.historical.yieldAtAssuranceM3Year!).toBeGreaterThanOrEqual(r.historical.firmYieldM3Year!);
		const rel = oa.summary.supplyAssurance!.reliability.find((x) => x.nodeId === 'F1')!;
		expect(r.historical.applicantAssurance).toBe(rel.waterYears ? rel.waterYearsMet / rel.waterYears : null);
	});

	it('runs each case as the baseline and the application under its climate.delta op', () => {
		const c = fixtureFactorTable().cases[5]!;
		const op = futureCaseOp(c, fixtureFactorTable());
		const { baseline, application } = inputs();
		const ob = runModel(applyScenario(baseline, [op]).input);
		const oa = runModel(applyScenario(application, [op]).input);
		const got = r.cases[5]!;
		expect(got).toMatchObject({ model: c.model, ssp: c.ssp, horizon: c.horizon, ewrDaysBaseline: ob.summary.catchment.ewrDaysNotMet, ewrDaysApplication: oa.summary.catchment.ewrDaysNotMet });
		expect(got.firmYieldM3Year).toBe(firmYield(applyScenario(application, [op]).input, 'F1').yieldM3Year);
		expect(op.label).toBe(`${c.model} ${c.ssp === 'ssp245' ? 'SSP2-4.5' : 'SSP5-8.5'} ${c.horizon === 'mid' ? '2036–2065' : '2066–2095'}`);
	});

	it('reads every SSP and horizon across the models, and says when there are fewer than five', () => {
		expect(r.cases).toHaveLength(12);
		expect(r.groups.map((g) => `${g.ssp} ${g.horizon}`)).toEqual(['ssp245 mid', 'ssp245 late', 'ssp585 mid', 'ssp585 late']);
		for (const g of r.groups) {
			expect(g.models).toEqual(['SYN-A', 'SYN-B', 'SYN-C']);
			const cs = r.cases.filter((c) => c.ssp === g.ssp && c.horizon === g.horizon);
			expect(g.firmYieldM3Year).toEqual(futureRange(cs.map((c) => c.firmYieldM3Year)));
			expect(g.ewrDaysChange).toEqual(futureRange(cs.map((c) => c.ewrDaysChange)));
		}
		expect(r).toMatchObject({ models: ['SYN-A', 'SYN-B', 'SYN-C'], fewModels: true, minModels: FUTURE_MIN_MODELS, version: 'future-1', method: 'delta-1', engineVersion: ENGINE_VERSION, nodeName: 'Farm one' });
		// Positive control: five models are enough.
		expect(run(fixtureFactorTable(5)).fewModels).toBe(false);
	});

	it('gives the historical values to the bit when every factor is 1', () => {
		const one = run(flat(1, 1));
		for (const c of one.cases) {
			const { model: _m, ssp: _s, horizon: _h, ...m } = c;
			expect(m).toEqual(one.historical);
		}
	});

	it('never lowers the firm yield as the rain factor rises (single dam, no return flow)', () => {
		const ys = [0.7, 0.85, 1, 1.15, 1.3].map((f) => run(flat(f)).cases[0]!.firmYieldM3Year!);
		for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]! * (1 - 0.002));
		// Positive control: the range isn't flat.
		expect(ys.at(-1)!).toBeGreaterThan(ys[0]!);
	});

	it('refuses a unit with no dam, and a table it can’t read', () => {
		const { application } = inputs();
		expect(futureDamError(application, 'G')).toMatch(/is of a dam/);
		expect(futureDamError(application, 'nope')).toMatch(/not in the application/);
		expect(futureDamError(application, 'F1')).toBeNull();
		expect(() => runFutureYield({ ...inputs(), nodeId: 'G', ownedNodeIds: ['F1'], factors: fixtureFactorTable() })).toThrow(/is of a dam/);
		const bad = fixtureFactorTable();
		bad.cases[0]!.rainFactorByMonth[3] = 1.6;
		expect(futureFactorTableError(bad)).toBe('SYN-A ssp245 mid: month 4: must be from 0.5 to 1.5');
		const missing = { ...fixtureFactorTable(), cases: fixtureFactorTable().cases.slice(1) };
		expect(futureFactorTableError(missing)).toBe('every model needs a case for each SSP and horizon');
		const twice = fixtureFactorTable();
		twice.cases[1] = { ...twice.cases[0]! };
		expect(futureFactorTableError(twice)).toBe('SYN-A ssp245 mid is listed twice');
		expect(futureFactorTableError({ ...fixtureFactorTable(), method: 'delta-0' })).toMatch(/method is delta-0/);
		expect(futureFactorTableError(fixtureFactorTable())).toBeNull();
	});

	it('stops when told to', () => {
		let calls = 0;
		expect(() => runFutureYield({ ...inputs(), nodeId: 'F1', ownedNodeIds: ['F1'], factors: fixtureFactorTable(), onCase: () => ++calls < 3 })).toThrow('cancelled');
		expect(calls).toBe(3);
	});

	it('gives the same result case by case: the steps, the async driver and the sync one', async () => {
		const sync = run();
		const total = fixtureFactorTable().cases.length + 1;
		// The steps: one after the historical pair and one after each case, then the result.
		const steps = futureYieldSteps({ ...inputs(), nodeId: 'F1', ownedNodeIds: ['F1'], factors: fixtureFactorTable() });
		const seen: number[] = [];
		let s = steps.next();
		for (; !s.done; s = steps.next()) {
			expect(s.value.total).toBe(total);
			seen.push(s.value.done);
		}
		expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
		expect(JSON.stringify(s.value)).toBe(JSON.stringify(sync));
		// The async driver, awaiting between cases.
		const reported: number[] = [];
		const viaAsync = await runFutureYieldAsync({
			...inputs(),
			nodeId: 'F1',
			ownedNodeIds: ['F1'],
			factors: fixtureFactorTable(),
			onCase: async (done) => {
				reported.push(done);
				await Promise.resolve();
			}
		});
		expect(reported).toEqual(seen);
		expect(JSON.stringify(viaAsync)).toBe(JSON.stringify(sync));
	});

	it('runs no further case once the async caller says stop', async () => {
		const cases: number[] = [];
		await expect(
			runFutureYieldAsync({
				...inputs(),
				nodeId: 'F1',
				ownedNodeIds: ['F1'],
				factors: fixtureFactorTable(),
				onCase: async (done) => (cases.push(done), done < 2)
			})
		).rejects.toThrow('cancelled');
		// Told to stop after the first case (done 2): called no more, so no third pair ran.
		expect(cases).toEqual([1, 2]);
		// The checks still come first: a unit with no dam is refused before any run.
		const none: number[] = [];
		await expect(runFutureYieldAsync({ ...inputs(), nodeId: 'G', ownedNodeIds: ['F1'], factors: fixtureFactorTable(), onCase: (d) => void none.push(d) })).rejects.toThrow(/is of a dam/);
		expect(none).toEqual([]);
	});
});

describe('checkFutureYield (reproduce:pack’s climate:delta)', () => {
	const stored = JSON.parse(JSON.stringify(run()));

	it('passes on the stored result, run again from its frozen factors', () => {
		expect(checkFutureYield(stored, inputs(), ENGINE_VERSION)).toEqual([]);
	});

	it('fails on a case that doesn’t follow from its factors', () => {
		const t = structuredClone(stored);
		t.cases[2].firmYieldM3Year += 1;
		expect(checkFutureYield(t, inputs(), ENGINE_VERSION)).toEqual(['1 of 12 cases give other values (SYN-A SSP5-8.5 mid)']);
		const f = structuredClone(stored);
		f.factors.cases[0].rainFactorByMonth[0] = 0.9;
		expect(checkFutureYield(f, inputs(), ENGINE_VERSION).join('; ')).toMatch(/cases give other values/);
	});

	it('names the engine that built it on another builder version', () => {
		expect(checkFutureYield({ ...stored, version: 'future-0' }, inputs(), '9.9.9')).toEqual(['§ 8 was built with future-0; this code builds future-1: check out the engine that built the report (9.9.9)']);
	});
});

describe('the factor table from the copy’s cells', () => {
	const year = (y: number, k = 1, t = 0): ClimateYear => ({
		year: y,
		prMm: Array.from({ length: 12 }, (_, m) => (m >= 4 && m <= 7 ? 80 : 20) * k),
		tasmaxC: Array.from({ length: 12 }, (_, m) => 25 + 5 * Math.cos((m * Math.PI) / 6) + t),
		tasminC: Array.from({ length: 12 }, (_, m) => 12 + 5 * Math.cos((m * Math.PI) / 6) + t)
	});
	const years = (from: number, to: number, k = 1, t = 0) => Array.from({ length: to - from + 1 }, (_, i) => year(from + i, k, t));
	const src = (product: string) => ({ product, revision: 1, files: 3, filesSha256: 'b'.repeat(64), versions: ['v1.0'], licenses: [null] });
	const meta = { sources: [src('cmip6/SYN-B/ssp245'), src('cmip6/SYN-A/historical')], citation: 'c', licence: 'l' };

	it('works out every model × SSP × horizon on whole windows, sorted, its sources sorted', () => {
		const cell = { lat: -33.7, weight: 1, historical: years(1985, 2014), ssp245: years(2036, 2095, 0.9, 1), ssp585: years(2036, 2095, 0.8, 2) };
		const t = buildFutureFactorTable([{ model: 'SYN-B', cells: [cell] }, { model: 'SYN-A', cells: [cell] }], meta);
		expect(t.cases.map((c) => `${c.model} ${c.ssp} ${c.horizon}`)).toEqual([
			'SYN-A ssp245 mid', 'SYN-A ssp245 late', 'SYN-A ssp585 mid', 'SYN-A ssp585 late',
			'SYN-B ssp245 mid', 'SYN-B ssp245 late', 'SYN-B ssp585 mid', 'SYN-B ssp585 late'
		]);
		expect(t.cases[0]!.rainFactorByMonth.every((f) => Math.abs(f - 0.9) < 1e-12)).toBe(true);
		expect(t.cases[2]!.rainFactorByMonth.every((f) => Math.abs(f - 0.8) < 1e-12)).toBe(true);
		expect(t.cases[0]!.evapFactorByMonth.every((f) => f > 1)).toBe(true);
		expect(t.cases[0]!.years).toEqual({ baseline: 30, future: 30 });
		expect(t.sources.map((s) => s.product)).toEqual(['cmip6/SYN-A/historical', 'cmip6/SYN-B/ssp245']);
		expect(futureFactorsComplete(t)).toBe(true);
		expect(futureFactorTableError(t)).toBeNull();
	});

	it('counts the years a window held, and isn’t complete on part of one (the synthetic copy)', () => {
		const cell = { lat: -33.7, weight: 1, historical: years(2013, 2014), ssp245: [year(2036, 0.9), year(2066, 0.85)], ssp585: [year(2036, 0.8), year(2066, 0.7)] };
		const t = buildFutureFactorTable([{ model: 'SYN-A', cells: [cell] }], meta);
		expect(t.cases[0]!.years).toEqual({ baseline: 2, future: 1 });
		expect(t.cases[3]!.rainFactorByMonth.every((f) => Math.abs(f - 0.7) < 1e-12)).toBe(true);
		expect(futureFactorsComplete(t)).toBe(false);
		expect(() => buildFutureFactorTable([{ model: 'SYN-A', cells: [{ ...cell, ssp585: [year(2036)] }] }], meta)).toThrow('the climate record holds no year of the window 2066–2095');
	});
});

describe('the caveat', () => {
	it('is pending until NASA’s words, their address and the date read are all filled', () => {
		const c: FutureYieldCaveat = structuredClone(FUTURE_YIELD_CAVEAT);
		expect(futureCaveatPending({ ...c, nasa: { ...c.nasa, text: null } })).toBe(true);
		expect(futureCaveatPending({ ...c, nasa: { ...c.nasa, text: 'Words.', url: 'https://example.org/note.pdf', readOn: null } })).toBe(true);
		expect(futureCaveatPending({ ...c, nasa: { ...c.nasa, text: 'Words.', url: 'https://example.org/note.pdf', readOn: '2026-10-29' } })).toBe(false);
	});

	it('is quoted whole or not at all: once filled, its address and date are too, and the placeholder is gone', () => {
		const n = FUTURE_YIELD_CAVEAT.nasa;
		if (n.text === null) {
			// Not quoted yet (the tech note was 404): the section prints the marked placeholder, and the futureYield check stops issue (report.test.ts).
			expect(n.placeholder).toMatch(/^\[Placeholder: .* can’t be issued until the caveat is filled\.\]$/);
			expect(futureCaveatPending()).toBe(true);
		} else {
			expect(n.url).toMatch(/^https:\/\//);
			expect(n.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(n.text).not.toContain('Placeholder');
			expect(futureCaveatPending()).toBe(false);
		}
	});
});
