// The run's `observed_flow_quality` column (engine ≥ 1.48.0, CR-18 follow-on,
// docs/model.md §2.10h): the scored record's per-day classes, the same the
// fit reads, stored beside the scored `observed_flow` only when a day is
// flagged, and checked by the run's self-checks.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from './calendar';
import { prepareCalibration } from './calibrate/calibrate';
import { FLOW_DAY_FLAGS, FLOW_FLAG_CODE, FLOW_QUALITY_COLUMN, hasFlaggedDay, recordFlowFlags } from './calibrate/dayFlags';
import { defaultQualityFlags } from './calibrate/qualityFlagSettings';
import { gaugeSeriesKey, type ModelInput, type ModelOutput, type NetworkNode } from './project';
import { runModel, runModelCapturing, runModelChecked, runModelFrom } from './run';
import { checkResume } from './testing/warmstartInvariants';
import { checkFlowQuality } from './verify/checks';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const START = '2019-10-01';
const DAYS = 2 * 365;
const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 0,
	areaHiKm2: 0,
	areaLoKm2: 0,
	flowShareManual: null,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

/** A smooth record between 0.5 and 1.5 m³/s (no outlier, no flat stretch), blank every 50th day. */
const record = (scale = 1) => ({ startDate: START, values: Array.from({ length: DAYS }, (_, t) => (t % 50 === 7 ? null : scale * (1 + 0.5 * Math.sin((2 * Math.PI * t) / 97)))) });

/** Farm F drains to the inner gauge H, which drains to the outlet gauge G. */
function input(settings: ModelInput['settings'] = {}, series: ModelInput['series'] = {}): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 }, ...settings },
		model: {
			nodes: [
				node({ id: 'G', name: 'Outlet', kind: 'gauge' }),
				node({ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 1 }),
				node({ id: 'F', name: 'Farm', downstreamNodeId: 'H', areaKm2: 30, sortOrder: 2 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: Array.from({ length: DAYS }, (_, t) => (t % 11 === 0 ? 30 : t % 3 === 0 ? 2 : 0)) },
			...series
		}
	};
}

const col = (out: ModelOutput, nodeId: string | null = null) => out.series.find((s) => s.key === FLOW_QUALITY_COLUMN.key && s.nodeId === nodeId);
const RATING = { flow_observed_m3s: { gaugedMaxM3s: 1.4, gaugedMinM3s: 0.6, source: 'Synthetic rating table' } };

describe('observed_flow_quality', () => {
	it('stores the outlet record’s classes, the fit’s own, beside observed_flow; missing where the record is blank', () => {
		const inp = input({ qualityFlags: { ...defaultQualityFlags(), ratings: RATING } }, { flow_observed_m3s: record() });
		const out = runModelChecked(inp);
		const q = col(out)!;
		expect(q.label).toBe(FLOW_QUALITY_COLUMN.label);
		expect(q.values).toHaveLength(out.days);
		// Beside its record: right after the observed series.
		const keys = out.series.filter((s) => s.nodeId === null).map((s) => s.key);
		expect(keys.indexOf(FLOW_QUALITY_COLUMN.key)).toBeGreaterThan(keys.indexOf('observed_flow'));
		// The fit reads the same classes (recordFlowFlags in both).
		expect(q.values).toEqual(Array.from(prepareCalibration(inp).flowFlags!));
		const obs = out.series.find((s) => s.nodeId === null && s.key === 'observed_flow')!.values;
		for (let t = 0; t < out.days; t++) {
			const v = obs[t]! / 86_400;
			const want = !Number.isFinite(obs[t]!) ? 'missing' : v > 1.4 ? 'aboveRating' : v < 0.6 ? 'belowRating' : 'inRange';
			expect(FLOW_DAY_FLAGS[q.values[t]!], `day ${t}`).toBe(want);
		}
		expect(q.values.filter((c) => c === FLOW_FLAG_CODE.aboveRating).length).toBeGreaterThan(20);
		expect(q.values.filter((c) => c === FLOW_FLAG_CODE.belowRating).length).toBeGreaterThan(20);
		expect(out.summary.verification!.passed).toBe(true);
	});

	it('is not stored when no day is flagged (only in range or missing); positive control: a rating that flags days stores it', () => {
		const plain = runModel(input({}, { flow_observed_m3s: record() }));
		expect(plain.series.some((s) => s.key === 'observed_flow')).toBe(true);
		expect(col(plain)).toBeUndefined();
		expect(checkFlowQuality(input({}, { flow_observed_m3s: record() }), plain)).toBeNull();
		const rated = runModel(input({ qualityFlags: { ...defaultQualityFlags(), ratings: RATING } }, { flow_observed_m3s: record() }));
		expect(col(rated)).toBeDefined();
	});

	it('marks gap-filled days infilled, from the run’s fill', () => {
		const inp = input(
			{ flowGapFill: { flow_observed_m3s: { interpolateMaxDays: 3, donor: null, donorMaxDays: 60, donorMinOverlapDays: 365 }, flow_logger_m3s: null } },
			{ flow_observed_m3s: record() }
		);
		const out = runModelChecked(inp);
		const q = col(out)!.values;
		const fill = out.series.find((s) => s.nodeId === null && s.key === 'observed_flow_fill')!.values;
		expect(fill.some((c) => c !== 0)).toBe(true);
		for (let t = 0; t < out.days; t++) expect(q[t] === FLOW_FLAG_CODE.infilled, `day ${t}`).toBe(fill[t] !== 0);
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
	});

	it('follows the calibration site: stored at the inner gauge, from its record, with no outlet rating', () => {
		const series = { flow_observed_m3s: record(), [gaugeSeriesKey('flow_observed_m3s', 'H')]: record(2) };
		// The outlet record's rating (1.4 m³/s) is not the gauge's: its record (1 … 3 m³/s) would be above it on most days.
		const inp = input({ calibrationSiteNodeId: 'H', qualityFlags: { ...defaultQualityFlags(), ratings: RATING } }, series);
		const out = runModelChecked(inp);
		expect(out.summary.calibration?.siteNodeId).toBe('H');
		expect(col(out, null)).toBeUndefined();
		// No flagged day at the gauge (no rating applies, no fill, no suspect day): not stored there either.
		expect(col(out, 'H')).toBeUndefined();
		// A flat stretch at the gauge is suspect: now it is stored there.
		const flat = record(2);
		for (let t = 200; t < 400; t++) flat.values[t] = 1.7;
		const withFlat = { ...inp, series: { ...inp.series, [gaugeSeriesKey('flow_observed_m3s', 'H')]: flat } };
		const out2 = runModelChecked(withFlat);
		const q = col(out2, 'H')!.values;
		expect(col(out2, null)).toBeUndefined();
		expect(q.filter((c) => c === FLOW_FLAG_CODE.suspect).length).toBeGreaterThan(100);
		expect(q.some((c) => c === FLOW_FLAG_CODE.aboveRating || c === FLOW_FLAG_CODE.belowRating)).toBe(false);
		expect(q).toEqual(Array.from(prepareCalibration(withFlat).flowFlags!));
		expect(out2.summary.verification!.passed).toBe(true);
	});

	it('the self-check catches a column that disagrees with its record (and passes the one the run stored)', () => {
		const inp = input({ qualityFlags: { ...defaultQualityFlags(), ratings: RATING } }, { flow_observed_m3s: record() });
		const out = runModel(inp);
		expect(checkFlowQuality(inp, out)).toBeNull();
		const tamper = (f: (v: number[]) => void, nodeId: string | null = null): ModelOutput => ({
			...out,
			series: out.series.map((s) => {
				if (s.key !== FLOW_QUALITY_COLUMN.key) return s;
				const values = [...s.values];
				f(values);
				return { ...s, values, nodeId };
			})
		});
		const inRange = col(out)!.values.indexOf(FLOW_FLAG_CODE.inRange);
		const above = col(out)!.values.indexOf(FLOW_FLAG_CODE.aboveRating);
		const blank = col(out)!.values.indexOf(FLOW_FLAG_CODE.missing);
		expect(checkFlowQuality(inp, tamper((v) => (v[inRange] = FLOW_FLAG_CODE.aboveRating)))).toMatch(/flagged above the highest gauging/);
		expect(checkFlowQuality(inp, tamper((v) => (v[above] = FLOW_FLAG_CODE.inRange)))).toMatch(/flagged in range/);
		expect(checkFlowQuality(inp, tamper((v) => (v[blank] = FLOW_FLAG_CODE.inRange)))).toMatch(/where observed_flow is NaN/);
		expect(checkFlowQuality(inp, tamper((v) => (v[inRange] = FLOW_FLAG_CODE.infilled)))).toMatch(/filled nothing/);
		expect(checkFlowQuality(inp, tamper((v) => (v[inRange] = FLOW_FLAG_CODE.humanUse)))).toMatch(/human use/);
		expect(checkFlowQuality(inp, tamper((v) => (v[inRange] = 9)))).toMatch(/not a class code/);
		expect(checkFlowQuality(inp, tamper(() => {}, 'H'))).toMatch(/but the run scores the outlet/);
	});

	it('a run resumed from a snapshot keeps the column, computed for its own days, even with no flagged day left', () => {
		// Only the first year is above the rating: resumed in the second, no day of the tail is flagged.
		const values = record().values.map((v, t) => (v === null ? null : t < 365 ? v : Math.min(v, 1.3)));
		const inp = input({ qualityFlags: { ...defaultQualityFlags(), ratings: { flow_observed_m3s: { gaugedMaxM3s: 1.4, gaugedMinM3s: null, source: 'Synthetic' } } } }, { flow_observed_m3s: { startDate: START, values } });
		expect(checkResume(inp, 500)).toBeNull();
		expect(checkResume(inp, 100)).toBeNull();
	});

	it('a resumed run given the flow record without its history leaves the suspect class out and says so; with the history it matches', () => {
		// A flat stretch across the snapshot's day (2020-10-01, run day 366): the full run calls its days suspect.
		const values = record().values.slice();
		for (let t = 340; t < 400; t++) values[t] = 1.1;
		const inp = input({ qualityFlags: { ...defaultQualityFlags(), ratings: RATING } }, { flow_observed_m3s: { startDate: START, values } });
		const at = toEpochDay('2020-10-01') - toEpochDay(START);
		const { output, snapshot } = runModelCapturing(inp, '2020-10-01');
		const full = col(output)!.values;
		expect(full.slice(at, 400).every((c) => c === FLOW_FLAG_CODE.suspect)).toBe(true);
		const stored = () => JSON.parse(JSON.stringify(snapshot));
		// With the history: the uninterrupted run's codes, no warning.
		const withHistory = runModelFrom(stored(), inp);
		expect(col(withHistory)!.values).toEqual(full.slice(at));
		expect(withHistory.summary.warnings.some((w) => w.includes('quality flags leave out the suspect class'))).toBe(false);
		// Without it (every series from the snapshot's day on): no suspect day, and a warning naming why.
		const cut = (s: { startDate: string; values: (number | null)[] }) => ({ startDate: '2020-10-01', values: s.values.slice(at) });
		const bare = runModelFrom(stored(), { ...inp, series: { rain_catchment_mm: cut(inp.series.rain_catchment_mm!), flow_observed_m3s: cut(inp.series.flow_observed_m3s!) } });
		const codes = col(bare)!.values;
		expect(codes.includes(FLOW_FLAG_CODE.suspect)).toBe(false);
		expect(bare.summary.warnings).toContainEqual(expect.stringMatching(/^Resumed from 2020-10-01 without the observed flow record's history: its quality flags leave out the suspect class/));
		// The rating classes don't need the history: those days match.
		for (let t = 0; t < codes.length; t++) if (full[at + t] !== FLOW_FLAG_CODE.suspect) expect(codes[t], `day ${t}`).toBe(full[at + t]);
		expect(checkFlowQuality({ ...inp, settings: { ...inp.settings, simulationStart: '2020-10-01' } }, bare)).toBeNull();
	});

	it('a record that starts after the snapshot’s day has no history to miss: no warning', () => {
		const late = { startDate: '2020-11-01', values: record().values.slice(0, 300) };
		const inp = input({ qualityFlags: { ...defaultQualityFlags(), ratings: RATING } }, { flow_observed_m3s: late });
		const { snapshot } = runModelCapturing(inp, '2020-10-01');
		const at = toEpochDay('2020-10-01') - toEpochDay(START);
		const rain = inp.series.rain_catchment_mm!;
		const bare = runModelFrom(JSON.parse(JSON.stringify(snapshot)), { ...inp, series: { rain_catchment_mm: { startDate: '2020-10-01', values: rain.values.slice(at) }, flow_observed_m3s: late } });
		expect(bare.summary.warnings.some((w) => w.includes('quality flags leave out the suspect class'))).toBe(false);
	});

	it('a resumed run without the flow record (an outlook member’s input: rain and A-pan) has no column, not one of zeros', () => {
		const inp = input({ qualityFlags: { ...defaultQualityFlags(), ratings: RATING } }, { flow_observed_m3s: record() });
		const { output, snapshot } = runModelCapturing(inp, '2020-10-01');
		expect(col(output)).toBeDefined();
		// The member's input leaves the history out: rain from the snapshot's day on, no flow record.
		const at = toEpochDay('2020-10-01') - toEpochDay(START);
		const rain = inp.series.rain_catchment_mm!;
		const tail = runModelFrom(JSON.parse(JSON.stringify(snapshot)), { ...inp, series: { rain_catchment_mm: { startDate: '2020-10-01', values: rain.values.slice(at) } } });
		expect(tail.series.some((s) => s.key === 'observed_flow')).toBe(false);
		expect(col(tail)).toBeUndefined();
		expect(checkFlowQuality(inp, tail)).toBeNull();
	});
});

describe('recordFlowFlags', () => {
	const s = { startDate: '2020-01-01', values: [0.5, 2, null, 1, 0.1] };
	const start = toEpochDay('2020-01-01');
	const settings = { qualityFlags: { ...defaultQualityFlags(), ratings: { flow_observed_m3s: { gaugedMaxM3s: 1.5, gaugedMinM3s: 0.2, source: 'x' } } } };
	const fill = { flow_observed_m3s: { code: [0, 0, 1, 0, 0] } };

	it('applies the gauged range and the fill at the outlet', () => {
		const f = recordFlowFlags({ kind: 'flow_observed_m3s', series: s, start, days: 5, settings, siteNodeId: null, flowFill: fill });
		expect([...f].map((c) => FLOW_DAY_FLAGS[c])).toEqual(['inRange', 'aboveRating', 'infilled', 'inRange', 'belowRating']);
		expect(hasFlaggedDay(f)).toBe(true);
	});

	it('applies neither at an inner gauge: those are the outlet records’ settings', () => {
		const f = recordFlowFlags({ kind: 'flow_observed_m3s', series: s, start, days: 5, settings, siteNodeId: 'H', flowFill: fill });
		expect([...f].map((c) => FLOW_DAY_FLAGS[c])).toEqual(['inRange', 'inRange', 'missing', 'inRange', 'inRange']);
		expect(hasFlaggedDay(f)).toBe(false);
	});

	it('names every code in the column label', () => {
		for (const [i, f] of FLOW_DAY_FLAGS.entries()) expect(FLOW_QUALITY_COLUMN.label).toContain(`${i} = `);
		expect(FLOW_QUALITY_COLUMN.label).toContain('3 = above the highest gauging');
		expect(FLOW_DAY_FLAGS.length).toBe(7);
	});
});

describe('gap fill on a resumed run', () => {
	const at = toEpochDay('2020-10-01') - toEpochDay(START);
	const cut = (s: { startDate: string; values: (number | null)[] }) => ({ startDate: '2020-10-01', values: s.values.slice(at) });
	const LEFT_OUT = /^Resumed from 2020-10-01 without the observed gauge flow record's history: its gap fill is left out/;
	/** The gauge record with a 5-day gap across the snapshot's day, filled from the logger (a donor ratio over the whole overlap). */
	function filled(): ModelInput {
		const gauge = record().values.slice();
		for (let t = at - 2; t < at + 3; t++) gauge[t] = null;
		const logger = record(1.3).values.map((v, t) => (v === null ? 1.3 : v));
		return input(
			{ flowGapFill: { flow_observed_m3s: { interpolateMaxDays: 1, donor: 'flow_logger_m3s', donorMaxDays: 30, donorMinOverlapDays: 100 }, flow_logger_m3s: null } },
			{ flow_observed_m3s: { startDate: START, values: gauge }, flow_logger_m3s: { startDate: START, values: logger } }
		);
	}

	it('with the history the resumed run fills exactly as the uninterrupted run (every series to the bit)', () => {
		const inp = filled();
		const full = runModel(inp);
		const fill = full.series.find((s) => s.nodeId === null && s.key === 'observed_flow_fill')!.values;
		// Positive control: the gap across the snapshot's day is filled from the donor, and single-day gaps interpolated.
		expect(fill.slice(at, at + 3).every((c) => c === 2)).toBe(true);
		expect(fill.includes(1)).toBe(true);
		expect(checkResume(inp, at)).toBeNull();
		expect(checkResume(inp, 100)).toBeNull();
	});

	it('without the history the fill is left out with a warning, never filled differently', () => {
		const inp = filled();
		const { snapshot } = runModelCapturing(inp, '2020-10-01');
		const bare = runModelFrom(JSON.parse(JSON.stringify(snapshot)), {
			...inp,
			series: { rain_catchment_mm: cut(inp.series.rain_catchment_mm!), flow_observed_m3s: cut(inp.series.flow_observed_m3s!), flow_logger_m3s: cut(inp.series.flow_logger_m3s!) }
		});
		expect(bare.summary.warnings).toContainEqual(expect.stringMatching(LEFT_OUT));
		expect(bare.series.some((s) => s.key === 'observed_flow_fill' || s.key === 'observed_flow_filled')).toBe(false);
		expect(bare.summary.flowGapFill).toBeUndefined();
		// Nothing is flagged infilled; the scored record is the stored one, its gaps still blank.
		expect(col(bare)?.values.includes(FLOW_FLAG_CODE.infilled) ?? false).toBe(false);
		const obs = bare.series.find((s) => s.nodeId === null && s.key === 'observed_flow')!.values;
		expect(obs.slice(0, 3).every((v) => Number.isNaN(v))).toBe(true);
		expect(checkFlowQuality({ ...inp, settings: { ...inp.settings, simulationStart: '2020-10-01' } }, bare)).toBeNull();
	});

	it('a fill that read no history before the snapshot’s day (the record and its donor start after it) is kept, without a warning', () => {
		const late = (s: { values: (number | null)[] }) => ({ startDate: '2020-11-01', values: s.values.slice(0, 300) });
		const base = filled();
		const inp = { ...base, series: { ...base.series, flow_observed_m3s: late(record()), flow_logger_m3s: late(record(1.3)) } };
		const { snapshot } = runModelCapturing(inp, '2020-10-01');
		const bare = runModelFrom(JSON.parse(JSON.stringify(snapshot)), { ...inp, series: { ...inp.series, rain_catchment_mm: cut(inp.series.rain_catchment_mm!) } });
		expect(bare.summary.warnings.some((w) => LEFT_OUT.test(w))).toBe(false);
		expect(bare.series.some((s) => s.key === 'observed_flow_fill')).toBe(true);
	});
});
