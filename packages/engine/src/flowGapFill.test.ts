// Gap filling of the observed flow records (engine ≥ 1.23.0, issue #66,
// docs/model.md §2.10i): each method, the gap-length edges, the donor's fit
// and its refusals, the clamp, the stored record untouched, a record without
// gaps unchanged, and the run: off is the same run to the bit, on with
// infilled days left out (settings.qualityFlags) scores the same days, and
// scored, the filled days too; and the fit's quality flags mark them infilled.
// A low-flow period's high readings (issue #567) anchor nothing, are out of the
// donor's ratio either way round and are not the clamp; with no period the fill
// is bit-identical.
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
	gapFillLowFlow,
	resolveFlowGapFill,
	type FlowGapFillSpec
} from './flowGapFill';
import type { LowFlowPeriod } from './calibrate/qualityFlagSettings';
import { prepareRun } from './prepare';
import { prepareCalibration } from './calibrate/calibrate';
import { defaultQualityFlags, observedInfillMask } from './calibrate/dayFlags';
import type { DailySeries, ModelInput } from './project';
import { runModel } from './run';
import { randomInput } from './testing/fuzz';
import { sameOutput } from './testing/invariants';
import { checkFlowQuality, checkReportTotals } from './verify/checks';

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

/** A low-flow period on `kind` over record days `a … b` (records start 2020-01-01). */
const period = (kind: LowFlowPeriod['kind'], a: number, b: number, maxM3s: number): LowFlowPeriod => {
	const d0 = toEpochDay('2020-01-01');
	return { kind, start: fromEpochDay(d0 + a), end: fromEpochDay(d0 + b), maxM3s, reason: 'logger capped', source: 'site visit' };
};

describe('fillFlowGaps: a low-flow period’s high readings (issue #567)', () => {
	it('with no period reaching either record, fills to the bit as without one', () => {
		const { record, donor } = pair(800, [
			[100, 101],
			[400, 419]
		]);
		const s = spec({ interpolateMaxDays: 3, donor: 'flow_logger_m3s', donorMaxDays: 30 });
		const plain = fillFlowGaps('flow_observed_m3s', record, s, donor);
		expect(gapFillLowFlow(undefined, 'flow_observed_m3s', record, 'flow_logger_m3s', donor)).toBeNull();
		expect(gapFillLowFlow([], 'flow_observed_m3s', record, 'flow_logger_m3s', donor)).toBeNull();
		// A period of a record that is neither, or one outside both records' days: nothing to read past.
		const elsewhere = [period('flow_logger_m3s', 0, 799, 0.1)];
		expect(gapFillLowFlow(elsewhere, 'flow_observed_m3s', record, 'flow_reference_m3s', donor)).toBeNull();
		expect(gapFillLowFlow([period('flow_observed_m3s', 900, 950, 0.1)], 'flow_observed_m3s', record, 'flow_logger_m3s', donor)).toBeNull();
		// A period every reading is at or below: thresholds, but no wrong reading, so the same fill.
		const lax = gapFillLowFlow([period('flow_observed_m3s', 0, 799, 100), period('flow_logger_m3s', 0, 799, 100)], 'flow_observed_m3s', record, 'flow_logger_m3s', donor);
		expect(lax).not.toBeNull();
		const same = fillFlowGaps('flow_observed_m3s', record, s, donor, lax);
		expect(same.values).toEqual(plain.values);
		expect(Array.from(same.code)).toEqual(Array.from(plain.code));
		expect(same.summary).toEqual(plain.summary);
		expect(fillFlowGaps('flow_observed_m3s', record, s, donor, null)).toEqual(plain);
	});

	it('anchors no interpolation on a reading above the threshold, never fills that day, and leaves the gap to the donor', () => {
		const record = rec([1, 50, null, null, 1]);
		const lowFlow = gapFillLowFlow([period('flow_observed_m3s', 0, 4, 2)], 'flow_observed_m3s', record, null, null);
		// Without the period the wrong 50 anchors the gap: 50 · (1/50)^(1/3) on its first day.
		expect(fillFlowGaps('flow_observed_m3s', record, spec()).values[2]).toBeCloseTo(50 * Math.pow(1 / 50, 1 / 3), 12);
		const f = fillFlowGaps('flow_observed_m3s', record, spec(), null, lowFlow);
		expect(f.values).toEqual([1, 50, null, null, 1]);
		expect(Array.from(f.code)).toEqual([0, 0, 0, 0, 0]);
		expect(f.summary).toMatchObject({ interpolatedDays: 0, interpolatedGaps: 0, openGaps: 1, openDays: 2 });
		// Short as it is, a donor may fill it, since nothing it reads is wrong.
		const { record: long, donor } = pair(800, [[400, 401]]);
		long.values[399] = 50;
		const lf = gapFillLowFlow([period('flow_observed_m3s', 390, 410, 5)], 'flow_observed_m3s', long, 'flow_logger_m3s', donor);
		const d = fillFlowGaps('flow_observed_m3s', long, spec({ interpolateMaxDays: 5, donor: 'flow_logger_m3s' }), donor, lf);
		expect(Array.from(d.code.slice(399, 402))).toEqual([FLOW_FILL_CODE.none, FLOW_FILL_CODE.donor, FLOW_FILL_CODE.donor]);
		expect(d.values[399]).toBe(50);
		expect(d.values[400]).toBeCloseTo(2 * donor.values[400]!, 12);
		expect(d.summary).toMatchObject({ interpolatedDays: 0, donorDays: 2, donorGaps: 1, openGaps: 0 });
	});

	it('leaves this record’s wrong high readings out of the donor’s ratio and correlation', () => {
		const { record, donor } = pair(800, [[400, 409]]);
		for (let i = 100; i < 150; i++) record.values[i] = 20; // a capped logger reading high: wrong
		const s = spec({ interpolateMaxDays: 0, donor: 'flow_logger_m3s' });
		const inflated = fillFlowGaps('flow_observed_m3s', record, s, donor);
		expect(inflated.summary.donor!.ratio).toBeGreaterThan(2.5);
		const lowFlow = gapFillLowFlow([period('flow_observed_m3s', 90, 160, 5)], 'flow_observed_m3s', record, 'flow_logger_m3s', donor);
		const f = fillFlowGaps('flow_observed_m3s', record, s, donor, lowFlow);
		expect(f.summary.donor!.ratio).toBeCloseTo(2, 12);
		expect(f.summary.donor!.correlation).toBeCloseTo(1, 12);
		expect(f.summary.donor!.overlapDays).toBe(800 - 10 - 50);
		for (let i = 400; i <= 409; i++) expect(f.values[i]).toBeCloseTo(2 * donor.values[i]!, 12);
		// The wrong days stay as stored, never filled.
		expect(f.values.slice(100, 150).every((v) => v === 20)).toBe(true);
		expect(f.code.slice(100, 150).every((c) => c === FLOW_FILL_CODE.none)).toBe(true);
	});

	it('leaves the donor’s wrong high readings out of the ratio, and fills no day from one', () => {
		const { record, donor } = pair(800, [[400, 409]]);
		for (let i = 100; i < 150; i++) donor.values[i] = 20;
		donor.values[405] = 20;
		const s = spec({ interpolateMaxDays: 0, donor: 'flow_logger_m3s' });
		expect(fillFlowGaps('flow_observed_m3s', record, s, donor).summary.donor!.ratio).toBeLessThan(1.5);
		const lowFlow = gapFillLowFlow([period('flow_logger_m3s', 90, 160, 5), period('flow_logger_m3s', 405, 405, 5)], 'flow_observed_m3s', record, 'flow_logger_m3s', donor);
		expect(lowFlow!.record).toBeNull();
		const f = fillFlowGaps('flow_observed_m3s', record, s, donor, lowFlow);
		expect(f.summary.donor!.ratio).toBeCloseTo(2, 12);
		expect(f.summary.donor!.overlapDays).toBe(800 - 10 - 50);
		expect(f.values[405]).toBeNull();
		expect(f.code[405]).toBe(FLOW_FILL_CODE.none);
		expect(f.values[404]).toBeCloseTo(2 * donor.values[404]!, 12);
		expect(f.summary).toMatchObject({ donorDays: 9, openGaps: 1, openDays: 1 });
	});

	it('clamps to the highest reading that is not wrong', () => {
		const { record, donor } = pair(800, [[400, 409]]);
		const max = Math.max(...record.values.filter((v): v is number => v !== null));
		record.values[50] = 100; // wrong: inside the period, above its threshold
		donor.values[403] = 50; // a donor flood, 100 after scaling
		const lowFlow = gapFillLowFlow([period('flow_observed_m3s', 40, 60, 5)], 'flow_observed_m3s', record, 'flow_logger_m3s', donor);
		const s = spec({ interpolateMaxDays: 0, donor: 'flow_logger_m3s' });
		// Without the period the wrong 100 is the clamp, and the flood passes.
		expect(fillFlowGaps('flow_observed_m3s', record, s, donor).summary.clampM3s).toBe(100);
		const f = fillFlowGaps('flow_observed_m3s', record, s, donor, lowFlow);
		expect(f.summary.clampM3s).toBe(max);
		expect(f.values[403]).toBe(max);
		expect(f.summary.clampedDays).toBe(1);
	});
});

describe('fillFlowGaps: low-flow periods, seeded records (issue #567)', () => {
	/** mulberry32: a small seeded generator, so a failure names its seed. */
	const rng = (seed: number) => () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const thrAt = (thr: Float64Array | null | undefined, i: number) => (thr ? thr[i]! : NaN);

	it('anchors, fits, clamps and fills only from readings at or below their thresholds; no period fills to the bit', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const r = rng(seed);
			const n = 200 + Math.floor(r() * 400);
			const donorVals = Array.from({ length: n }, (_, i) => Math.max(0, 1 + Math.sin(i / 15) + (r() - 0.5) * 0.3));
			const recVals: (number | null)[] = donorVals.map((v) => 2 * v * (0.9 + r() * 0.2));
			for (let g = 0; g < 8; g++) {
				const a = Math.floor(r() * n);
				const len = 1 + Math.floor(r() * 12);
				for (let i = a; i < Math.min(n, a + len); i++) recVals[i] = null;
			}
			// Wrong highs in both records, inside periods.
			for (let i = 0; i < n; i++) {
				if (r() < 0.04 && recVals[i] !== null) recVals[i] = 20 + r() * 20;
				if (r() < 0.02) donorVals[i] = 15 + r() * 10;
			}
			const record = rec(recVals);
			const donor = rec(donorVals);
			const periods: LowFlowPeriod[] = [];
			for (let k = 0; k < 3; k++) {
				const a = Math.floor(r() * n);
				periods.push(period(r() < 0.5 ? 'flow_observed_m3s' : 'flow_logger_m3s', a, Math.min(n - 1, a + Math.floor(r() * n * 0.6)), 4 + r() * 2));
			}
			const s = spec({ interpolateMaxDays: 1 + Math.floor(r() * 5), donor: 'flow_logger_m3s', donorMaxDays: 30, donorMinOverlapDays: 30 });
			const plain = fillFlowGaps('flow_observed_m3s', record, s, donor);
			// (e) No period reaching either record: the same fill to the bit.
			for (const none of [undefined, [], [period('flow_observed_m3s', n + 10, n + 20, 0.1)]]) {
				expect(fillFlowGaps('flow_observed_m3s', record, s, donor, gapFillLowFlow(none, 'flow_observed_m3s', record, 'flow_logger_m3s', donor)), `seed ${seed}`).toEqual(plain);
			}
			const lf = gapFillLowFlow(periods, 'flow_observed_m3s', record, 'flow_logger_m3s', donor);
			const f = fillFlowGaps('flow_observed_m3s', record, s, donor, lf);
			const wrongRec = (i: number) => recVals[i] !== null && recVals[i]! > thrAt(lf?.record, i);
			let max: number | null = null;
			for (let i = 0; i < n; i++) if (recVals[i] !== null && !wrongRec(i) && (max === null || recVals[i]! > max)) max = recVals[i]!;
			// (c) The clamp is the highest reading not above its threshold.
			expect(f.summary.clampM3s, `seed ${seed}`).toBe(max);
			for (let i = 0; i < n; i++) {
				// (b) A wrong reading keeps its stored value and is never filled.
				if (wrongRec(i)) {
					expect(f.code[i], `seed ${seed} day ${i}`).toBe(FLOW_FILL_CODE.none);
					expect(f.values[i]).toBe(recVals[i]);
				}
				if (f.code[i] === FLOW_FILL_CODE.donor) {
					// (c) No donor fill above the clamp; (d) none from a wrong donor reading.
					expect(f.values[i]! <= max! * (1 + 1e-12), `seed ${seed} day ${i}`).toBe(true);
					expect(donorVals[i]! > thrAt(lf?.donor, i), `seed ${seed} day ${i}`).toBe(false);
				}
				// (a) An interpolated gap's anchors (the readings either side of the run of filled days) are not wrong.
				if (f.code[i] === FLOW_FILL_CODE.interpolated && (i === 0 || f.code[i - 1] !== FLOW_FILL_CODE.interpolated)) {
					let j = i;
					while (f.code[j + 1] === FLOW_FILL_CODE.interpolated) j++;
					expect(wrongRec(i - 1) || wrongRec(j + 1), `seed ${seed} gap ${i}–${j}`).toBe(false);
				}
			}
		}
	});
});

describe('resolveFlowGapFill', () => {
	it('is off by default and for anything missing', () => {
		expect(resolveFlowGapFill(undefined)).toEqual(defaultFlowGapFill());
		expect(resolveFlowGapFill({})).toEqual(defaultFlowGapFill());
	});

	it('fills absent fields with the defaults and warns about invalid ones', () => {
		const w: string[] = [];
		const r = resolveFlowGapFill({ flow_observed_m3s: { interpolateMaxDays: 99, donor: 'flow_observed_m3s' }, flow_logger_m3s: 'yes' }, w);
		expect(r).toEqual({ flow_observed_m3s: { ...DEFAULT_FLOW_GAP_SPEC, donor: null }, flow_logger_m3s: null });
		expect(w).toHaveLength(3);
		expect(w.join(' ')).toMatch(/not another flow record/);
	});

	it('ignores the retired useFilledDays switch, saying where the one control is', () => {
		const w: string[] = [];
		expect(resolveFlowGapFill({ useFilledDays: true }, w)).toEqual(defaultFlowGapFill());
		expect(w).toEqual([expect.stringMatching(/useFilledDays is retired and ignored: .*Quality flags for Fit automatically → Infilled days/)]);
		// Off, it says nothing.
		const quiet: string[] = [];
		resolveFlowGapFill({ useFilledDays: false }, quiet);
		expect(quiet).toEqual([]);
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

	it('on, with infilled days left out (the default): the same scores and flows, plus the fill columns, summary and a warning', () => {
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
		expect(on.summary.warnings.some((w) => /observed gauge flow: gaps filled in the run/.test(w) && /Infilled days are left out \(quality flags, the default\)/.test(w))).toBe(true);
	});

	const fill = { flow_observed_m3s: spec({ interpolateMaxDays: 5 }), flow_logger_m3s: null };
	const withInfilled = (use: 'include' | 'exclude'): ModelInput => ({
		...input,
		settings: { ...input.settings, flowGapFill: fill, qualityFlags: { ...defaultQualityFlags(), infilled: use } }
	});

	it('with infilled days scored (settings.qualityFlags.infilled), the statistics score the filled days too', () => {
		const off = runModel(input);
		const on = runModel(withInfilled('include'));
		const filled = on.summary.flowGapFill![0]!.interpolatedDays;
		expect(on.summary.calibration!.days).toBe(off.summary.calibration!.days + filled);
		// The EWR test on the observed record follows the same rule.
		expect(on.summary.catchment.ewrAgreement!.days).toBe(off.summary.catchment.ewrAgreement!.days + filled);
		expect(on.summary.warnings.some((w) => /Infilled days are scored/.test(w))).toBe(true);
		// Left out (the default, and said so), the run is the one without scoring.
		expect(runModel(withInfilled('exclude')).summary.calibration).toEqual(off.summary.calibration);
	});

	it('flags each filled day infilled for the fit, and leaves it out unless the infilled treatment scores it', () => {
		const filled = runModel(withInfilled('exclude')).summary.flowGapFill![0]!.interpolatedDays;
		const left = prepareCalibration(withInfilled('exclude'));
		const scored = prepareCalibration(withInfilled('include'));
		const none = prepareCalibration(input);
		expect(left.dayQuality!.flow.infilled).toBe(filled);
		expect(scored.dayQuality!.flow.infilled).toBe(filled);
		// Without a fill the gap days are missing, not infilled.
		expect(none.dayQuality!.flow.infilled).toBe(0);
		expect(none.dayQuality!.flow.missing - left.dayQuality!.flow.missing).toBe(filled);
		// Left out: the fit scores the measured days only; scored: the filled ones too.
		expect(left.scoredDays.length).toBe(none.scoredDays.length);
		expect(scored.scoredDays.length).toBe(none.scoredDays.length + filled);
		expect(left.dayQuality!.notes.some((n) => /of gap-filled flow are left out/.test(n))).toBe(true);
		// The observedInfillMask the flags read is the fill's code, 1 on each filled day.
		const mask = observedInfillMask(prepareRun(withInfilled('exclude')).flowFill!.flow_observed_m3s)!;
		expect(mask.reduce((a, b) => a + b, 0)).toBe(filled);
		expect(observedInfillMask(null)).toBeNull();
	});

	it('reads past a low-flow period’s high readings in a run, and fills as before with none (issue #567)', () => {
		const obs = input.series.flow_observed_m3s!;
		const values = obs.values.slice();
		values[49] = 1e4; // a wrong high reading beside the gap at 50–52
		const at = (i: number) => fromEpochDay(toEpochDay(obs.startDate) + i);
		const p: LowFlowPeriod = { kind: 'flow_observed_m3s', start: at(40), end: at(60), maxM3s: 1e3, reason: 'capped', source: 'site visit' };
		const withPeriods = (periods: LowFlowPeriod[] | undefined): ModelInput => ({
			...input,
			series: { ...input.series, flow_observed_m3s: { ...obs, values } },
			settings: { ...input.settings, flowGapFill: fill, qualityFlags: { ...defaultQualityFlags(), infilled: 'include', ...(periods ? { lowFlowPeriods: periods } : {}) } }
		});
		const none = prepareRun(withPeriods(undefined));
		const off = (t: number) => t - (none.start - toEpochDay(obs.startDate));
		expect(none.flowFill!.flow_observed_m3s!.code[off(50)]).toBe(FLOW_FILL_CODE.interpolated);
		// Periods that read past nothing (the logger's; an empty list) fill to the bit as none.
		for (const periods of [[], [{ ...p, kind: 'flow_logger_m3s' as const }]]) {
			const same = prepareRun(withPeriods(periods)).flowFill!.flow_observed_m3s!;
			expect(Array.from(same.code)).toEqual(Array.from(none.flowFill!.flow_observed_m3s!.code));
			expect(same.values).toEqual(none.flowFill!.flow_observed_m3s!.values);
		}
		expect(sameOutput(runModel(withPeriods(undefined)), runModel(withPeriods([])))).toBe(true);
		const read = prepareRun(withPeriods([p])).flowFill!.flow_observed_m3s!;
		expect(Array.from(read.code.slice(off(49), off(53)))).toEqual([0, 0, 0, 0]);
		expect(read.summary.openGaps).toBe(none.flowFill!.flow_observed_m3s!.summary.openGaps + 1);
	});

	it('scores a filled day above a period’s threshold by the infilled treatment, as the fit does, never as a period high (issue #567)', () => {
		const obs = input.series.flow_observed_m3s!;
		// A gap whose anchors read above 0, so every filled day does; the period covers only its days, no reading.
		const at0 = [50, 120, 200].find((a) => obs.values[a - 1]! > 0 && obs.values[a + 3]! > 0)!;
		expect(at0).toBeDefined();
		const day = (i: number) => fromEpochDay(toEpochDay(obs.startDate) + i);
		const lowest = Math.min(obs.values[at0 - 1]!, obs.values[at0 + 3]!);
		const p: LowFlowPeriod = { kind: 'flow_observed_m3s', start: day(at0), end: day(at0 + 2), maxM3s: lowest / 2, reason: 'capped', source: 'site visit' };
		const run = (periods: LowFlowPeriod[] | undefined, use: 'include' | 'exclude') =>
			runModel({ ...input, settings: { ...input.settings, flowGapFill: fill, qualityFlags: { ...defaultQualityFlags(), infilled: use, ...(periods ? { lowFlowPeriods: periods } : {}) } } });
		for (const use of ['include', 'exclude'] as const) {
			const none = run(undefined, use);
			const withP = run([p], use);
			expect(withP.summary.calibration).toEqual(none.summary.calibration);
			expect(withP.summary.catchment.ewrAgreement).toEqual(none.summary.catchment.ewrAgreement);
			const scored = withInfilled(use);
			expect(checkReportTotals(scored, withP)).toBeNull();
			expect(checkFlowQuality({ ...scored, settings: { ...scored.settings, qualityFlags: { ...scored.settings!.qualityFlags!, lowFlowPeriods: [p] } } }, withP)).toBeNull();
		}
		// And the fit's flags call those days infilled, not period highs.
		const fit = prepareCalibration({ ...withInfilled('include'), settings: { ...withInfilled('include').settings, qualityFlags: { ...defaultQualityFlags(), infilled: 'include', lowFlowPeriods: [p] } } });
		expect(fit.dayQuality!.flow.periodHigh ?? 0).toBe(0);
	});

	it('exposes the per-day mask on the prepared run (what the per-day quality flags read)', () => {
		const prep = prepareRun(withFill({ ...defaultFlowGapFill(), flow_observed_m3s: spec() }));
		const f = prep.flowFill!.flow_observed_m3s!;
		expect(f.code.length).toBe(prep.days);
		expect(f.summary).toEqual(fillSummaryInWindow(fillFlowGaps('flow_observed_m3s', input.series.flow_observed_m3s!, spec()), prep.start, prep.days));
		expect(prepareRun(input).flowFill).toBeNull();
	});
});
