// Model-state snapshots (engine 1.1.0, issue #53, docs/model.md §2.16):
// capture the state at the start of a day, resume from it, and refuse a
// snapshot that isn't this input's. On the invented outlook catchment
// (../outlook/testCatchment.ts) and hand-made variants of it; random
// networks are in ./warmstart.invariants.test.ts.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput } from '../project';
import { testCatchment } from '../outlook/testCatchment';
import { captureModelState, runModelCapturing, runModelFrom, runModelWithoutChecks } from '../run';
import { checkResume, tailDifference } from '../testing/warmstartInvariants';
import { ENGINE_VERSION } from '../version';
import { historyFingerprint, MODEL_STATE_FORMAT, MODEL_STATE_KIND, ModelStateMismatchError, modelStateFingerprint, withDamStorage, type ModelStateSnapshot } from './snapshot';

const col = (out: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string) => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values;
const dayIndex = (out: Pick<ModelOutput, 'startDate'>, date: string) => toEpochDay(date) - toEpochDay(out.startDate);
const clone = <T>(v: T): T => structuredClone(v);
const roundTrip = (s: ModelStateSnapshot): ModelStateSnapshot => JSON.parse(JSON.stringify(s));

/** The split days the tests resume at, on a record from 2000-10-01 to 2013-09-30. */
const SPLITS = [
	['the first day', '2000-10-01'],
	['a 29 February', '2004-02-29'],
	['the day after a 29 February', '2008-03-01'],
	['a water-year boundary', '2006-10-01'],
	['mid-month', '2009-05-17'],
	['the last day', '2013-09-30']
] as const;

const variants: [string, ModelInput][] = [
	['GR4J, soil-water store, daily A-pan', testCatchment({ dailyApan: true })],
	['GR4J without a soil-water store', (() => {
		const x = testCatchment();
		x.settings.effectiveRainStoreMm = 0;
		return x;
	})()],
	['land cover and a Reserve rule table', testCatchment({ dailyApan: true, recordWide: true })]
];

describe('capture and resume on the invented catchment', () => {
	for (const [name, input] of variants) {
		const full = runModelWithoutChecks(input);
		for (const [where, at] of SPLITS) {
			it(`${name}: resumed at ${where} (${at}), every series is the uninterrupted run's to the bit`, () => {
				expect(checkResume(input, dayIndex(full, at), full)).toBeNull();
			});
		}
		it(`${name}: a snapshot of the day after the run leaves the run unchanged`, () => {
			expect(checkResume(input, full.days, full)).toBeNull();
		});
	}

	it('a Reserve month split by the snapshot is still assessed whole, as in the uninterrupted run', () => {
		const input = testCatchment({ recordWide: true });
		const full = runModelWithoutChecks(input);
		const tail = runModelFrom(captureModelState(input, '2009-05-17'), input);
		const may = (o: ModelOutput) => o.summary.ewrAssurance![0]!.months.find((m) => m.year === 2009 && m.month === 5)!;
		expect(may(tail)).toEqual(may(full));
		expect(col(tail, null, 'ewr_rule')![0]).toBe(col(full, null, 'ewr_rule')![dayIndex(full, '2009-05-17')]);
	});

	it('the summary covers the resumed days only', () => {
		const input = testCatchment();
		const full = runModelWithoutChecks(input);
		const tail = runModelFrom(captureModelState(input, '2010-10-01'), input);
		expect(tail.startDate).toBe('2010-10-01');
		expect(tail.endDate).toBe(full.endDate);
		const k = dayIndex(full, '2010-10-01');
		const supplied = col(full, 'a', 'supplied')!.slice(k);
		expect(tail.summary.farms.find((f) => f.nodeId === 'a')!.avgSuppliedM3Day).toBeCloseTo(supplied.reduce((s, v) => s + v, 0) / supplied.length, 9);
	});
});

describe('the snapshot', () => {
	const input = testCatchment({ dailyApan: true, recordWide: true });
	const { output, snapshot } = runModelCapturing(input, '2009-05-17');

	it('is versioned plain data that survives JSON, and resumes the same after it', () => {
		expect(snapshot).toMatchObject({ kind: MODEL_STATE_KIND, format: MODEL_STATE_FORMAT, engineVersion: ENGINE_VERSION, date: '2009-05-17', runStart: '2000-10-01' });
		const back = roundTrip(snapshot);
		expect(back).toEqual(snapshot);
		expect(runModelFrom(back, input)).toEqual(runModelFrom(snapshot, input));
		expect(JSON.stringify(snapshot)).not.toMatch(/undefined|NaN|Infinity/);
	});

	it('holds the state of every node, the runoff stores and the pinned statistics', () => {
		const s = snapshot.state;
		expect(s.nodes.map((n) => n.id)).toEqual(['g', 'a', 'b']);
		// The dams' storage is the end of the day before.
		const k = dayIndex(output, '2009-05-17');
		expect(s.nodes[1]!.storageM3).toBe(col(output, 'a', 'dam_storage')![k - 1]);
		expect(s.runoff.model).toBe('gr4j');
		// GR4J: S, R and both unit-hydrograph queues (X4 = 1.5: 2 + 3 ordinates).
		expect(s.runoff.state).toHaveLength(2 + 2 + 3);
		expect(s.pinned.lowFlowThresholdM3Day).toBe(output.summary.landCover!.lowFlowThresholdM3Day);
		expect(s.pinned.reserveNatural).toEqual([{ site: '', curves: output.summary.ewrAssurance![0]!.byMonth.map((m) => m.naturalCurve) }]);
		expect(s.reserveMonths[0]!.carry).toMatchObject({ days: 16 });
	});

	it('pins the record-wide statistics: a resumed run with other rain keeps the capture run’s', () => {
		// Rain after the snapshot day doubled: an uninterrupted run would refit the low-flow threshold and the natural curves.
		const wetter = clone(input);
		const d0 = toEpochDay(wetter.series.rain_catchment_mm!.startDate);
		wetter.series.rain_catchment_mm!.values = wetter.series.rain_catchment_mm!.values.map((v, i) => (d0 + i >= toEpochDay('2009-05-17') && v !== null ? v * 2 : v));
		const refit = runModelWithoutChecks(wetter);
		const tail = runModelFrom(snapshot, wetter);
		expect(refit.summary.landCover!.lowFlowThresholdM3Day).not.toBe(output.summary.landCover!.lowFlowThresholdM3Day);
		expect(tail.summary.landCover!.lowFlowThresholdM3Day).toBe(output.summary.landCover!.lowFlowThresholdM3Day);
		const curves = (o: ModelOutput) => o.summary.ewrAssurance![0]!.byMonth.map((m) => m.naturalCurve);
		expect(curves(refit)).not.toEqual(curves(output));
		expect(curves(tail)).toEqual(curves(output));
	});

	it('pins the CHIRPS factors: new CHIRPS days after the snapshot don’t refit them', () => {
		// Invented CHIRPS reading 20 % high, and a gap in the catchment gauge after the snapshot so CHIRPS stands in.
		const x = testCatchment();
		x.settings.chirpsBiasCorrection = 'monthly';
		const c = x.series.rain_catchment_mm!;
		x.series.rain_chirps_mm = { startDate: c.startDate, values: c.values.map((v) => (v === null ? null : Math.round(v * 12) / 10)) };
		const gap = [toEpochDay('2011-06-01'), toEpochDay('2011-08-31')];
		const c0 = toEpochDay(c.startDate);
		c.values = c.values.map((v, i) => (c0 + i >= gap[0]! && c0 + i <= gap[1]! ? null : v));
		const snap = captureModelState(x, '2011-01-01');
		const full = runModelWithoutChecks(x);
		expect(tailDifference(full, runModelFrom(snap, x), dayIndex(full, '2011-01-01'))).toBeNull();
		// CHIRPS after the snapshot three times higher: an uninterrupted run fits other factors, the resumed one keeps the capture's.
		const y = clone(x);
		y.series.rain_chirps_mm!.values = y.series.rain_chirps_mm!.values.map((v, i) => (c0 + i >= toEpochDay('2011-01-01') && v !== null ? v * 3 : v));
		const factor = (o: ModelOutput, date: string) => col(o, null, 'chirps_factor')![dayIndex(o, date)];
		expect(factor(runModelWithoutChecks(y), '2011-07-01')).not.toBe(factor(full, '2011-07-01'));
		expect(factor(runModelFrom(snap, y), '2011-07-01')).toBe(factor(full, '2011-07-01'));
	});
});

describe('what the resumed input may and may not change', () => {
	const input = testCatchment({ dailyApan: true });
	const at = '2010-10-01';
	const snapshot = captureModelState(input, at);
	const full = runModelWithoutChecks(input);
	const k = dayIndex(full, at);

	it('the history may be left out: the new days’ series alone resume the same', () => {
		const tailOnly = clone(input);
		for (const s of Object.values(tailOnly.series)) {
			const cut = toEpochDay(at) - toEpochDay(s!.startDate);
			s!.values = s!.values.slice(cut);
			s!.startDate = at;
		}
		expect(historyFingerprint(tailOnly, at)).toBeNull();
		expect(tailDifference(full, runModelFrom(snapshot, tailOnly), k)).toBeNull();
	});

	it('the new days’ driving series may differ; the history may not', () => {
		const later = clone(input);
		const r = later.series.rain_catchment_mm!;
		r.values[r.values.length - 10] = 99;
		expect(() => runModelFrom(snapshot, later)).not.toThrow();
		const earlier = clone(input);
		earlier.series.rain_catchment_mm!.values[100] = 99;
		expect(() => runModelFrom(snapshot, earlier)).toThrow(ModelStateMismatchError);
		expect(() => runModelFrom(snapshot, earlier)).toThrow(/series before 2010-10-01 differ/);
	});

	it('refuses a snapshot of another model or other settings, naming why', () => {
		const bigger = clone(input);
		bigger.model.nodes[1]!.damCapacityM3 *= 2;
		const other = clone(input);
		other.settings.gr4j = { ...other.settings.gr4j!, x1: 310 };
		for (const x of [bigger, other]) {
			let err: unknown;
			try {
				runModelFrom(snapshot, x);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(ModelStateMismatchError);
			expect((err as ModelStateMismatchError).code).toBe('input');
			expect((err as Error).message).toMatch(/captured from another model or other settings/);
		}
		// The window and the reporting window are not the history.
		const window = clone(input);
		window.settings.simulationEnd = '2012-09-30';
		window.settings.reportStart = '2011-10-01';
		expect(runModelFrom(snapshot, window).endDate).toBe('2012-09-30');
	});

	it('refuses a snapshot from another engine version or format', () => {
		expect(() => runModelFrom({ ...snapshot, engineVersion: '0.0.1' }, input)).toThrow(/captured by engine 0\.0\.1, and this is engine/);
		expect(() => runModelFrom({ ...snapshot, format: (MODEL_STATE_FORMAT + 1) as never }, input)).toThrow(new RegExp(`format ${MODEL_STATE_FORMAT + 1}`));
		// Format 1 (engine < 1.6.0) carried a part month's base-flow sum, not the days a resumed run's base flow is filtered over.
		expect(MODEL_STATE_FORMAT).toBe(2);
		expect(() => runModelFrom({ ...snapshot, format: 1 as never }, input)).toThrow(/format 1; this engine reads format 2/);
		expect(() => runModelFrom({ ...snapshot, kind: 'x' as never }, input)).toThrow(/not a model-state snapshot/);
		try {
			runModelFrom({ ...snapshot, engineVersion: '0.0.1' }, input);
		} catch (e) {
			expect((e as ModelStateMismatchError).code).toBe('engineVersion');
		}
	});

	it('a demand factor from the snapshot day on is free, and is the uninterrupted run’s', () => {
		const scaled = clone(input);
		for (const n of scaled.model.nodes) if (n.kind === 'farm') n.demandFactor = new Array(12).fill(0.6);
		scaled.settings.demandFactorFrom = at;
		expect(modelStateFingerprint(scaled, at)).toBe(snapshot.inputFingerprint);
		expect(tailDifference(runModelWithoutChecks(scaled), runModelFrom(snapshot, scaled), k)).toBeNull();
		// From before the snapshot day it would have changed the history: refused.
		scaled.settings.demandFactorFrom = '2009-10-01';
		expect(() => runModelFrom(snapshot, scaled)).toThrow(ModelStateMismatchError);
	});

	it('a dated demand factor from the snapshot day on is free, and is the uninterrupted run’s (engine 1.82.0)', () => {
		const dated = clone(input);
		for (const n of dated.model.nodes) if (n.kind === 'farm') n.demandFactorWindows = [{ from: at, factor: new Array(12).fill(1.3) }];
		expect(modelStateFingerprint(dated, at)).toBe(snapshot.inputFingerprint);
		expect(tailDifference(runModelWithoutChecks(dated), runModelFrom(snapshot, dated), k)).toBeNull();
		// One starting before the snapshot day changed the history: refused.
		for (const n of dated.model.nodes) if (n.kind === 'farm') n.demandFactorWindows = [{ from: '2009-10-01', to: at, factor: new Array(12).fill(1.3) }];
		expect(modelStateFingerprint(dated, at)).not.toBe(snapshot.inputFingerprint);
		expect(() => runModelFrom(snapshot, dated)).toThrow(ModelStateMismatchError);
	});

	it('a storage reset on the snapshot day is the uninterrupted run’s; withDamStorage gives the same days without the step column', () => {
		const storageM3 = { a: 50_000, b: 140_000 };
		const reset = clone(input);
		reset.settings.damStorageReset = { date: at, storageM3 };
		const uninterrupted = runModelWithoutChecks(reset);
		expect(tailDifference(uninterrupted, runModelFrom(snapshot, reset), k)).toBeNull();
		const set = runModelFrom(withDamStorage(snapshot, input, storageM3), input);
		for (const s of set.series) {
			expect(s.values, `${s.nodeId}/${s.key}`).toEqual(col(uninterrupted, s.nodeId, s.key)!.slice(k));
		}
		expect(col(set, 'a', 'dam_storage_set')).toBeUndefined();
		expect(() => withDamStorage(snapshot, input, { g: 5 })).toThrow(/not a unit with a dam/);
		// A reset before the snapshot day is in the history: the capture input must have had it.
		const before = clone(input);
		before.settings.damStorageReset = { date: '2009-01-01', storageM3 };
		expect(() => runModelFrom(snapshot, before)).toThrow(ModelStateMismatchError);
		const snapBefore = captureModelState(before, at);
		expect(tailDifference(runModelWithoutChecks(before), runModelFrom(snapBefore, before), k)).toBeNull();
	});

	it('refuses a capture date outside the run and a run that ends before the snapshot', () => {
		expect(() => captureModelState(input, '2000-09-30')).toThrow(/outside the run/);
		expect(() => captureModelState(input, '2013-10-02')).toThrow(/outside the run/);
		expect(() => captureModelState(input, '2013-02-30')).toThrow(/not an ISO date/);
		const short = clone(input);
		short.settings.simulationEnd = '2010-09-30';
		expect(() => runModelFrom(snapshot, short)).toThrow(/ends \(2010-09-30\) before/);
	});

	it('is the same under a skewed TZ', () => {
		const tz = process.env.TZ;
		process.env.TZ = 'Pacific/Kiritimati';
		try {
			const again = captureModelState(input, at);
			expect(again).toEqual(snapshot);
			expect(tailDifference(full, runModelFrom(again, input), k)).toBeNull();
		} finally {
			process.env.TZ = tz;
		}
	});
});

describe('the snapshot day', () => {
	it('is the first day the resumed run simulates: its state is the end of the day before', () => {
		const input = testCatchment();
		const full = runModelWithoutChecks(input);
		for (const at of ['2003-03-01', '2003-02-28']) {
			const tail = runModelFrom(captureModelState(input, at), input);
			expect(tail.startDate).toBe(at);
			expect(col(tail, 'a', 'dam_storage')![0]).toBe(col(full, 'a', 'dam_storage')![dayIndex(full, at)]);
		}
		expect(fromEpochDay(toEpochDay(full.startDate) + full.days)).toBe('2013-10-01');
	});
});
