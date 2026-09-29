// Gap filling of the observed flow records (engine ≥ 1.23.0, issue #66,
// docs/model.md §2.10i): each method, the gap-length edges, the donor's fit
// and its refusals, the clamp, the stored record untouched, a record without
// gaps unchanged, and the run: off is the same run to the bit, on without
// useFilledDays scores the same days, and with it scores the filled days too.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from './calendar';
import {
	DEFAULT_FLOW_GAP_SPEC,
	defaultFlowGapFill,
	DONOR_MIN_CORRELATION,
	fillFlowGaps,
	fillSummaryInWindow,
	FLOW_FILL_CODE,
	FLOW_FILL_COLUMNS,
	flowFillWarning,
	resolveFlowGapFill,
	type FlowGapFillSpec
} from './flowGapFill';
import { prepareRun } from './prepare';
import type { DailySeries, ModelInput } from './project';
import { runModel } from './run';
import { randomInput } from './testing/fuzz';
import { sameOutput } from './testing/invariants';

const spec = (s: Partial<FlowGapFillSpec> = {}): FlowGapFillSpec => ({ ...DEFAULT_FLOW_GAP_SPEC, ...s });
const rec = (values: (number | null)[], startDate = '2020-01-01'): DailySeries => ({ startDate, values });

describe('fillFlowGaps: interpolation', () => {
	it('fills a short gap log-linearly between the readings either side', () => {
		const f = fillFlowGaps('flow_observed_m3s', rec([8, null, null, null, 0.5]), spec({ interpolateMaxDays: 3 }));
		// 8 · (0.5/8)^(k/4): 4, 2, 1 — a recession halving each day.
		expect(f.values.slice(1, 4).map((v) => +v!.toFixed(12))).toEqual([4, 2, 1]);
		expect(Array.from(f.code)).toEqual([0, 1, 1, 1, 0]);
		expect(f.summary).toMatchObject({ interpolatedDays: 3, interpolatedGaps: 1, openGaps: 0 });
	});

	it('is linear where either side is 0', () => {
		const f = fillFlowGaps('flow_observed_m3s', rec([0, null, 3]), spec());
		expect(f.values[1]).toBeCloseTo(1.5, 12);
	});

	it('fills a gap of exactly the maximum and leaves one a day longer open', () => {
		const at = fillFlowGaps('flow_observed_m3s', rec([1, null, null, 1]), spec({ interpolateMaxDays: 2 }));
		expect(at.summary.interpolatedDays).toBe(2);
		const over = fillFlowGaps('flow_observed_m3s', rec([1, null, null, null, 1]), spec({ interpolateMaxDays: 2 }));
		expect(over.values.slice(1, 4)).toEqual([null, null, null]);
		expect(over.summary).toMatchObject({ interpolatedDays: 0, openGaps: 1, openDays: 3 });
	});

	it('never fills the lead-in or the tail (nothing bounds them), and 0 days turns it off', () => {
		const f = fillFlowGaps('flow_observed_m3s', rec([null, 2, null, 2, null]), spec({ interpolateMaxDays: 5 }));
		expect(f.values).toEqual([null, 2, 2, 2, null]);
		expect(fillFlowGaps('flow_observed_m3s', rec([2, null, 2]), spec({ interpolateMaxDays: 0 })).values[1]).toBeNull();
	});

	it('reads a negative or non-finite value as missing, as a run does', () => {
		const f = fillFlowGaps('flow_observed_m3s', rec([1, -999, Number.NaN, 1]), spec());
		expect(f.values).toEqual([1, 1, 1, 1]);
		expect(f.summary.interpolatedDays).toBe(2);
	});

	it('never changes the stored record, and a record without gaps comes back as it was', () => {
		const stored = rec([3, null, 1]);
		const copy = structuredClone(stored);
		fillFlowGaps('flow_observed_m3s', stored, spec());
		expect(stored).toEqual(copy);
		const full = rec([1, 2, 3, 0, 5]);
		const f = fillFlowGaps('flow_observed_m3s', full, spec({ donor: 'flow_logger_m3s' }), rec([1, 1, 1, 1, 1]));
		expect(f.values).toEqual(full.values);
		expect(Array.from(f.code).every((c) => c === 0)).toBe(true);
	});

	it('crosses a leap day like any other', () => {
		const f = fillFlowGaps('flow_observed_m3s', rec([4, null, 1], '2024-02-28'), spec());
		expect(f.values[1]).toBeCloseTo(2, 12);
	});
});

/** A donor with a seasonal wave, and the record = 2 × donor (with its own gaps). */
function pair(days: number, gaps: [number, number][], opts: { noise?: (i: number) => number } = {}) {
	const donor = Array.from({ length: days }, (_, i) => 1 + Math.sin(i / 20) * 0.8 + (opts.noise?.(i) ?? 0));
	const record: (number | null)[] = donor.map((v) => 2 * v);
	for (const [a, b] of gaps) for (let i = a; i <= b; i++) record[i] = null;
	return { record: rec(record), donor: rec(donor) };
}

describe('fillFlowGaps: from a donor record', () => {
	it('fills a longer gap with the donor × the ratio of totals on shared days', () => {
		const { record, donor } = pair(800, [[400, 419]]);
		const f = fillFlowGaps('flow_observed_m3s', record, spec({ interpolateMaxDays: 3, donor: 'flow_logger_m3s', donorMaxDays: 30, donorMinOverlapDays: 365 }), donor);
		expect(f.summary.donor!.ratio).toBeCloseTo(2, 12);
		expect(f.summary.donor!.overlapDays).toBe(780);
		expect(f.summary.donor!.correlation).toBeCloseTo(1, 12);
		for (let i = 400; i <= 419; i++) {
			expect(f.values[i]).toBeCloseTo(2 * donor.values[i]!, 12);
			expect(f.code[i]).toBe(FLOW_FILL_CODE.donor);
		}
		expect(f.summary).toMatchObject({ donorDays: 20, donorGaps: 1, openGaps: 0, donorRefused: null });
	});

	it('interpolates a short gap even with a donor, and leaves a gap longer than donorMaxDays open', () => {
		const { record, donor } = pair(800, [
			[100, 101],
			[400, 440]
		]);
		const f = fillFlowGaps('flow_observed_m3s', record, spec({ interpolateMaxDays: 3, donor: 'flow_logger_m3s', donorMaxDays: 40 }), donor);
		expect(f.code[100]).toBe(FLOW_FILL_CODE.interpolated);
		expect(f.values.slice(400, 441).every((v) => v === null)).toBe(true);
		expect(f.summary).toMatchObject({ interpolatedDays: 2, donorDays: 0, openGaps: 1, openDays: 41 });
	});

	it('leaves the donor’s own missing days open inside a gap it fills', () => {
		const { record, donor } = pair(800, [[400, 409]]);
		donor.values[405] = null;
		const f = fillFlowGaps('flow_observed_m3s', record, spec({ interpolateMaxDays: 0, donor: 'flow_logger_m3s' }), donor);
		expect(f.values[405]).toBeNull();
		expect(f.summary).toMatchObject({ donorDays: 9, donorGaps: 1, openGaps: 1, openDays: 1 });
	});

	it('refuses a donor with too few shared days, and says so', () => {
		const { record, donor } = pair(200, [[100, 119]]);
		const f = fillFlowGaps('flow_observed_m3s', record, spec({ interpolateMaxDays: 0, donor: 'flow_logger_m3s', donorMinOverlapDays: 365 }), donor);
		expect(f.summary.donorDays).toBe(0);
		expect(f.summary.donorRefused).toMatch(/share 180 days/);
		expect(flowFillWarning(f.summary, false)).toMatch(/No gap was filled from the logger flow: the two records share 180 days/);
	});

	it(`refuses a donor whose flows correlate below ${DONOR_MIN_CORRELATION}`, () => {
		const donor = rec(Array.from({ length: 800 }, (_, i) => (i % 2 ? 1 : 3)));
		const record = rec(Array.from({ length: 800 }, (_, i) => (i >= 400 && i < 420 ? null : 1 + Math.sin(i / 30))));
		const f = fillFlowGaps('flow_observed_m3s', record, spec({ interpolateMaxDays: 0, donor: 'flow_reference_m3s', donorMinOverlapDays: 30 }), donor);
		expect(f.summary.donor!.correlation!).toBeLessThan(DONOR_MIN_CORRELATION);
		expect(f.summary.donorRefused).toMatch(/correlate/);
		expect(f.summary.donorDays).toBe(0);
	});

	it('says so when the project has no donor record', () => {
		const f = fillFlowGaps('flow_observed_m3s', rec([1, null, 1]), spec({ interpolateMaxDays: 0, donor: 'flow_logger_m3s' }), null);
		expect(f.summary.donorRefused).toBe('the project has no logger flow record');
	});

	it('clamps a filled day to the record’s highest reading', () => {
		const { record, donor } = pair(800, [[400, 409]]);
		donor.values[403] = 50; // a donor flood: 100 after scaling, far above anything the record measured
		const f = fillFlowGaps('flow_observed_m3s', record, spec({ interpolateMaxDays: 0, donor: 'flow_logger_m3s' }), donor);
		const max = Math.max(...record.values.filter((v): v is number => v !== null));
		expect(f.values[403]).toBe(max);
		expect(f.summary.clampedDays).toBe(1);
		expect(f.summary.clampM3s).toBe(max);
	});

	it('aligns records that start on different days', () => {
		const { record, donor } = pair(800, [[400, 409]]);
		// The donor starts 10 days later: drop its first 10 days.
		const later = rec(donor.values.slice(10), fromEpochDay(toEpochDay(donor.startDate) + 10));
		const f = fillFlowGaps('flow_observed_m3s', record, spec({ interpolateMaxDays: 0, donor: 'flow_logger_m3s' }), later);
		expect(f.values[405]).toBeCloseTo(2 * donor.values[405]!, 12);
	});
});

describe('resolveFlowGapFill', () => {
	it('is off by default and for anything missing', () => {
		expect(resolveFlowGapFill(undefined)).toEqual(defaultFlowGapFill());
		expect(resolveFlowGapFill({})).toEqual(defaultFlowGapFill());
	});

	it('fills absent fields with the defaults and warns about invalid ones', () => {
		const w: string[] = [];
		const r = resolveFlowGapFill({ flow_observed_m3s: { interpolateMaxDays: 99, donor: 'flow_observed_m3s' }, flow_logger_m3s: 'yes', useFilledDays: 'no' }, w);
		expect(r.flow_observed_m3s).toEqual({ ...DEFAULT_FLOW_GAP_SPEC, donor: null });
		expect(r.flow_logger_m3s).toBeNull();
		expect(r.useFilledDays).toBe(false);
		expect(w).toHaveLength(4);
		expect(w.join(' ')).toMatch(/not another flow record/);
	});
});

/** A seeded run with an observed record, and some gaps punched in it. */
function gappedInput(): ModelInput {
	for (let seed = 1; seed < 300; seed++) {
		const input = randomInput(seed, { maxDays: 600 });
		const obs = input.series.flow_observed_m3s;
		if (!obs || obs.values.length < 400 || input.settings?.calibrationFlowKind === 'flow_logger_m3s') continue;
		try {
			runModel(input);
		} catch {
			continue;
		}
		const values = obs.values.slice();
		for (const at of [50, 120, 200]) for (let i = at; i < at + 3; i++) values[i] = null;
		input.series.flow_observed_m3s = { ...obs, values };
		// Calibration over the whole run, so the filled days are inside the window.
		input.settings = { ...input.settings, calibrationStart: null, calibrationEnd: null, calibrationExclusions: [] };
		return input;
	}
	throw new Error('no seeded input with an observed record');
}

describe('runModel with gap filling', () => {
	const input = gappedInput();
	const withFill = (fill: unknown): ModelInput => ({ ...input, settings: { ...input.settings, flowGapFill: fill as never } });

	it('off (absent, or every record null) is the same run to the bit', () => {
		expect(sameOutput(runModel(input), runModel(withFill(defaultFlowGapFill())))).toBe(true);
		expect(runModel(input).summary.flowGapFill).toBeUndefined();
	});

	it('on, without useFilledDays: the same scores and flows, plus the fill columns, summary and a warning', () => {
		const off = runModel(input);
		const on = runModel(withFill({ ...defaultFlowGapFill(), flow_observed_m3s: spec({ interpolateMaxDays: 5 }) }));
		expect(on.summary.calibration).toEqual(off.summary.calibration);
		expect(on.summary.catchment.ewrAgreement).toEqual(off.summary.catchment.ewrAgreement);
		const get = (o: typeof on, key: string) => o.series.find((s) => s.nodeId === null && s.key === key);
		expect(get(on, 'simulated_outflow')!.values).toEqual(get(off, 'simulated_outflow')!.values);
		expect(get(on, 'observed_flow')!.values).toEqual(get(off, 'observed_flow')!.values);
		const code = get(on, FLOW_FILL_COLUMNS.observed_flow.code.key)!.values;
		const filled = get(on, FLOW_FILL_COLUMNS.observed_flow.values.key)!.values;
		const days = code.filter((c) => c === FLOW_FILL_CODE.interpolated).length;
		expect(days).toBeGreaterThan(0);
		// A filled value on exactly the filled days, NaN elsewhere.
		code.forEach((c, t) => expect(Number.isNaN(filled[t]!)).toBe(c === 0));
		expect(on.summary.flowGapFill![0]).toMatchObject({ kind: 'flow_observed_m3s', interpolatedDays: days });
		expect(on.summary.warnings.some((w) => /observed gauge flow: gaps filled in the run/.test(w) && /No statistic reads the filled days/.test(w))).toBe(true);
	});

	it('with useFilledDays, the statistics score the filled days too', () => {
		const off = runModel(input);
		const on = runModel(withFill({ flow_observed_m3s: spec({ interpolateMaxDays: 5 }), flow_logger_m3s: null, useFilledDays: true }));
		const filled = on.summary.flowGapFill![0]!.interpolatedDays;
		expect(on.summary.calibration!.days).toBe(off.summary.calibration!.days + filled);
		expect(on.summary.warnings.some((w) => /read the filled days/.test(w))).toBe(true);
	});

	it('exposes the per-day mask on the prepared run (what the per-day quality flags read)', () => {
		const prep = prepareRun(withFill({ ...defaultFlowGapFill(), flow_observed_m3s: spec() }));
		const f = prep.flowFill!.flow_observed_m3s!;
		expect(f.code.length).toBe(prep.days);
		expect(f.summary).toEqual(fillSummaryInWindow(fillFlowGaps('flow_observed_m3s', input.series.flow_observed_m3s!, spec()), prep.start, prep.days));
		expect(prepareRun(input).flowFill).toBeNull();
	});
});
