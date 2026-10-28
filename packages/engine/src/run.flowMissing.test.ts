// settings.flowMissing (issue #611, engine ≥ 1.102.0, ./recordPeriods.ts,
// docs/model.md §2.10h): one flow record's own missing periods, named by
// its series id. Where the run reads that record the days are gaps: the
// calibration statistics, the EWR test on the observed record, the fit's
// problem and its per-day classes skip them, the record's gap fill may fill
// them, and nothing else moves (no flow record drives the simulation).
// Also settings.checksKept: a kept outlier is scored as read. Synthetic
// catchment, invented values only.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from './calendar';
import { prepareCalibration } from './calibrate/calibrate';
import { FLOW_FLAG_CODE, FLOW_QUALITY_COLUMN, recordFlowFlags } from './calibrate/dayFlags';
import { defaultQualityFlags } from './calibrate/qualityFlagSettings';
import { resolveFlowMissing, withRecordPeriods } from './recordPeriods';
import { gaugeSeriesKey, type DailySeries, type ModelInput, type ModelOutput, type NetworkNode } from './project';
import { mergeSettings } from './prepare';
import { seriesRowFlags } from './quality';
import { runModelChecked } from './run';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const START = '2019-10-01';
const D0 = toEpochDay(START);
const DAYS = 2 * 365;
const OBS_ID = '00000000-0000-4000-8000-00000000f101';
const LOGGER_ID = '00000000-0000-4000-8000-00000000f102';
const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 0,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

/** A smooth record between 0.5 and 1.5 m³/s, blank every 50th day, named by `seriesId`. */
const record = (seriesId: string | null, scale = 1): DailySeries => ({
	startDate: START,
	values: Array.from({ length: DAYS }, (_, t) => (t % 50 === 7 ? null : scale * (1 + 0.5 * Math.sin((2 * Math.PI * t) / 97)))),
	...(seriesId ? { seriesId } : {})
});

/** Farm F (with a dam and a user) drains to the outlet gauge G; the observed and logger records at G. */
function input(settings: ModelInput['settings'] = {}, series: ModelInput['series'] = {}): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 }, calibrationFlowKind: 'flow_observed_m3s', ...settings },
		model: {
			nodes: [node({ id: 'G', name: 'Outlet', kind: 'gauge' }), node({ id: 'F', name: 'Farm', downstreamNodeId: 'G', areaKm2: 30, sortOrder: 1, damCapacityM3: 50_000, damInitialPct: 0.5 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: Array.from({ length: DAYS }, (_, t) => (t % 11 === 0 ? 30 : t % 3 === 0 ? 2 : 0)) },
			flow_observed_m3s: record(OBS_ID),
			flow_logger_m3s: record(LOGGER_ID, 1.1),
			...series
		}
	};
}

// Missing: 2020-01-01 … 2020-03-31 (91 days) of the observed record.
const FROM = '2020-01-01';
const TO = '2020-03-31';
const T0 = toEpochDay(FROM) - D0;
const T1 = toEpochDay(TO) - D0;
const MISSING = { [OBS_ID]: [{ start: FROM, end: TO, reason: 'Weir silted up (synthetic)' }] };

/** The observed record with those days blanked by hand: what flowMissing must read as. */
const blankedByHand = (): DailySeries => {
	const r = record(OBS_ID);
	for (let t = T0; t <= T1; t++) r.values[t] = null;
	return r;
};
const col = (out: ModelOutput, key: string, nodeId: string | null = null) => out.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;
/** Every output series but the observed record's own columns, which the periods are meant to change. */
const OBSERVED_KEYS = new Set(['observed_flow', 'observed_flow_other', FLOW_QUALITY_COLUMN.key, 'observed_flow_fill', 'observed_flow_filled']);
const simulated = (out: ModelOutput) => out.series.filter((s) => !OBSERVED_KEYS.has(s.key));

describe('settings.flowMissing: one record’s days are gaps where the run reads it', () => {
	it('scores as if those days were blank in the stored record: statistics, EWR test and plausibility', () => {
		const listed = runModelChecked(input({ flowMissing: MISSING }));
		const byHand = runModelChecked(input({}, { flow_observed_m3s: blankedByHand() }));
		expect(listed.summary.calibration).toEqual(byHand.summary.calibration);
		expect(listed.summary.catchment.ewrAgreement).toEqual(byHand.summary.catchment.ewrAgreement);
		expect(listed.summary.plausibility).toEqual(byHand.summary.plausibility);
		const obs = col(listed, 'observed_flow')!;
		for (let t = T0; t <= T1; t++) expect(Number.isNaN(obs[t]!), `day ${t}`).toBe(true);
		expect(Number.isFinite(obs[T0 - 1]!) && Number.isFinite(obs[T1 + 1]!)).toBe(true);
		expect(listed.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		// It says what it did, naming the record and the readings (the 50th-day blanks aren't readings).
		const blanks = Array.from({ length: T1 - T0 + 1 }, (_, i) => T0 + i).filter((t) => t % 50 === 7).length;
		expect(listed.summary.warnings.some((w) => w.startsWith(`Flow — observed gauge: ${T1 - T0 + 1 - blanks} readings in its own missing periods`))).toBe(true);
	});

	it('positive control: the statistics differ from the run without the periods, by the days left out', () => {
		const listed = runModelChecked(input({ flowMissing: MISSING }));
		const plain = runModelChecked(input());
		const blanks = Array.from({ length: T1 - T0 + 1 }, (_, i) => T0 + i).filter((t) => t % 50 === 7).length;
		expect(plain.summary.calibration!.days - listed.summary.calibration!.days).toBe(T1 - T0 + 1 - blanks);
		expect(listed.summary.calibration!.nse).not.toBe(plain.summary.calibration!.nse);
	});

	it('changes no simulated series and no water balance figure: no flow record drives the model', () => {
		const listed = runModelChecked(input({ flowMissing: MISSING }));
		const plain = runModelChecked(input());
		expect(simulated(listed)).toEqual(simulated(plain));
		expect(listed.summary.waterBalance).toEqual(plain.summary.waterBalance);
		expect(listed.summary.farms).toEqual(plain.summary.farms);
		expect(listed.summary.catchment.meanSimulatedOutflowM3Day).toBe(plain.summary.catchment.meanSimulatedOutflowM3Day);
		expect(listed.summary.catchment.meanNaturalFlowM3Day).toBe(plain.summary.catchment.meanNaturalFlowM3Day);
	});

	it('is one record’s: the other record and a record named by another id keep their days', () => {
		const other = runModelChecked(input({ calibrationFlowKind: 'flow_logger_m3s', flowMissing: MISSING }));
		const plainLogger = runModelChecked(input({ calibrationFlowKind: 'flow_logger_m3s' }));
		expect(other.summary.calibration).toEqual(plainLogger.summary.calibration);
		// The logger's own periods leave the observed record alone.
		const loggerOnly = runModelChecked(input({ flowMissing: { [LOGGER_ID]: MISSING[OBS_ID]! } }));
		expect(loggerOnly.summary.calibration).toEqual(runModelChecked(input()).summary.calibration);
		// A record without a series id matches nothing.
		const bare = runModelChecked(input({ flowMissing: MISSING }, { flow_observed_m3s: record(null) }));
		expect(bare.summary.calibration).toEqual(runModelChecked(input({}, { flow_observed_m3s: record(null) })).summary.calibration);
	});

	it('the fit’s problem skips the days and classes them missing, as the run’s quality column does', () => {
		const listed = prepareCalibration(input({ flowMissing: MISSING }));
		const byHand = prepareCalibration(input({}, { flow_observed_m3s: blankedByHand() }));
		const plain = (a: Float64Array) => Array.from(a).map((v) => (Number.isNaN(v) ? null : v));
		expect(plain(listed.observed)).toEqual(plain(byHand.observed));
		expect(Array.from(listed.scoredDays)).toEqual(Array.from(byHand.scoredDays));
		for (let t = T0; t <= T1; t++) expect(listed.flowFlags![t], `day ${t}`).toBe(FLOW_FLAG_CODE.missing);
		expect(listed.scoredDays.length).toBeLessThan(prepareCalibration(input()).scoredDays.length);
	});

	it('applies at an inner gauge’s record too (the calibration site)', () => {
		const GAUGE_ID = '00000000-0000-4000-8000-00000000f103';
		const nodes = [node({ id: 'G', name: 'Outlet', kind: 'gauge' }), node({ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 1 }), node({ id: 'F', name: 'Farm', downstreamNodeId: 'H', areaKm2: 30, sortOrder: 2 })];
		const at = (fm: ModelInput['settings']['flowMissing'], blank = false) => {
			const x = input({ calibrationSiteNodeId: 'H', ...(fm ? { flowMissing: fm } : {}) });
			x.model.nodes = nodes;
			const r = record(GAUGE_ID, 2);
			if (blank) for (let t = T0; t <= T1; t++) r.values[t] = null;
			(x.series as Record<string, DailySeries>)[gaugeSeriesKey('flow_observed_m3s', 'H')] = r;
			return x;
		};
		const listed = runModelChecked(at({ [GAUGE_ID]: MISSING[OBS_ID]! }));
		expect(listed.summary.calibration!.siteNodeId).toBe('H');
		expect(listed.summary.calibration).toEqual(runModelChecked(at(null, true)).summary.calibration);
		expect(listed.summary.calibration!.days).toBeLessThan(runModelChecked(at(null)).summary.calibration!.days);
	});

	it('a listed day is a gap the record’s gap fill may fill; the filled day then follows qualityFlags.infilled', () => {
		// A short period, inside the interpolation limit.
		const short = { [OBS_ID]: [{ start: '2020-02-10', end: '2020-02-11', reason: 'Logger swap (synthetic)' }] };
		const fill = { flow_observed_m3s: { interpolateMaxDays: 3, donor: null, donorMaxDays: 60, donorMinOverlapDays: 365 }, flow_logger_m3s: null };
		const out = runModelChecked(input({ flowMissing: short, flowGapFill: fill }));
		const t = toEpochDay('2020-02-10') - D0;
		expect(col(out, 'observed_flow_fill')![t]).not.toBe(0);
		expect(col(out, FLOW_QUALITY_COLUMN.key)![t]).toBe(FLOW_FLAG_CODE.infilled);
		// Excluded by default: scored as the hand-blanked record's filled day is.
		const r = record(OBS_ID);
		r.values[t] = null;
		r.values[t + 1] = null;
		const byHand = runModelChecked(input({ flowGapFill: fill }, { flow_observed_m3s: r }));
		expect(out.summary.calibration).toEqual(byHand.summary.calibration);
		// Scored when filled days are.
		const included = runModelChecked(input({ flowMissing: short, flowGapFill: fill, qualityFlags: { ...defaultQualityFlags(), infilled: 'include' } }));
		expect(included.summary.calibration!.days).toBe(runModelChecked(input({ flowGapFill: fill, qualityFlags: { ...defaultQualityFlags(), infilled: 'include' } }, { flow_observed_m3s: r })).summary.calibration!.days);
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
	});

	it('is the same under a skewed TZ (day boundaries are epoch days, never local time)', () => {
		const before = process.env.TZ;
		process.env.TZ = 'Pacific/Kiritimati';
		try {
			const listed = runModelChecked(input({ flowMissing: MISSING }));
			expect(listed.summary.calibration).toEqual(runModelChecked(input({}, { flow_observed_m3s: blankedByHand() })).summary.calibration);
		} finally {
			if (before === undefined) delete process.env.TZ;
			else process.env.TZ = before;
		}
	});

	it('is read only when stored: settings without it normalise as before', () => {
		expect('flowMissing' in mergeSettings({}, [])).toBe(false);
		const warnings: string[] = [];
		const s = mergeSettings({ flowMissing: { [OBS_ID]: [{ start: TO, end: FROM, reason: 'backwards' }, ...MISSING[OBS_ID]!], other: [] } as never }, warnings);
		expect(s.flowMissing).toEqual(MISSING);
		expect(warnings.some((w) => /flow missing period .* ends before it starts; ignored/.test(w))).toBe(true);
		// Idempotent: blanking the blanked series again changes nothing and says nothing.
		const once = withRecordPeriods(s, input().series, []);
		const again: string[] = [];
		expect(withRecordPeriods(s, once, again)).toBe(once);
		expect(again).toEqual([]);
	});
});

describe('settings.checksKept: a kept outlier or flat stretch is scored as read (open question 3)', () => {
	/** The observed record with a 30-day flat stretch at 1.7 m³/s and a spike: suspect by the data checks. */
	const flagged = (): DailySeries => {
		const r = record(OBS_ID);
		for (let t = 300; t < 330; t++) r.values[t] = 1.7;
		r.values[400] = 40;
		return r;
	};
	const flagsOf = (kept: string[] | undefined) => {
		const s = mergeSettings({ ...(kept ? { checksKept: kept } : {}) }, []);
		return recordFlowFlags({ kind: 'flow_observed_m3s', series: flagged(), start: D0, days: DAYS, settings: s, siteNodeId: null });
	};
	const day = (t: number) => fromEpochDay(D0 + t);
	/** An item id as the data checks build it: `<check>:<seriesId>:<start>:<end>` (issue #611). */
	const checkItemIdForTest = (check: string, seriesId: string, start: string, end: string) => `${check}:${seriesId}:${start}:${end}`;

	it('positive control: the stretch and the spike are suspect while open', () => {
		const rows = seriesRowFlags('flow_observed_m3s', flagged());
		expect(!!rows.outlier[400]).toBe(true);
		const f = flagsOf(undefined);
		for (let t = 300; t < 330; t++) expect(f[t], `day ${t}`).toBe(FLOW_FLAG_CODE.suspect);
		expect(f[400]).toBe(FLOW_FLAG_CODE.suspect);
	});

	it('kept, their days are in range; another record’s or another check’s item changes nothing', () => {
		const f = flagsOf([checkItemIdForTest('flatline', OBS_ID, day(300), day(329)), checkItemIdForTest('outlier', OBS_ID, day(400), day(400))]);
		for (let t = 300; t < 330; t++) expect(f[t], `day ${t}`).toBe(FLOW_FLAG_CODE.inRange);
		expect(f[400]).toBe(FLOW_FLAG_CODE.inRange);
		expect(Array.from(flagsOf([checkItemIdForTest('outlier', LOGGER_ID, day(400), day(400)), checkItemIdForTest('negative', OBS_ID, day(400), day(400)), 'not an item']))).toEqual(Array.from(flagsOf(undefined)));
	});

	it('the fit scores a kept day the default treatment leaves out', () => {
		const id = checkItemIdForTest('outlier', OBS_ID, day(400), day(400));
		const open = prepareCalibration(input({}, { flow_observed_m3s: flagged() }));
		const kept = prepareCalibration(input({ checksKept: [id] }, { flow_observed_m3s: flagged() }));
		expect(Array.from(open.scoredDays)).not.toContain(400);
		expect(Array.from(kept.scoredDays)).toContain(400);
		// The problem names the record it fits, whose kept checks a fit record keeps (provenance.ts keptForFit).
		expect(kept.flowSeriesId).toBe(OBS_ID);
		// …and the run's own quality column agrees (stored: the open flat stretch is still suspect).
		const out = runModelChecked(input({ checksKept: [id] }, { flow_observed_m3s: flagged() }));
		const q = col(out, FLOW_QUALITY_COLUMN.key)!;
		expect(q[400]).toBe(FLOW_FLAG_CODE.inRange);
		expect(q[310]).toBe(FLOW_FLAG_CODE.suspect);
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
	});
});

describe('resolveFlowMissing', () => {
	it('never writes a prototype key from the stored settings', () => {
		const raw = JSON.parse('{"__proto__": [{"start": "2019-01-01", "end": "2019-01-05", "reason": "gauge fault"}], "s1": [{"start": "2019-01-01", "end": "2019-01-05", "reason": "gauge fault"}]}');
		const out = resolveFlowMissing(raw, [])!;
		expect(Object.keys(out)).toEqual(['s1']);
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
	});
});

describe('settings.warningsKept (the Warnings page’s kept run warnings and problems): no run effect', () => {
	it('changes nothing a run reports', () => {
		const a = runModelChecked(input());
		const b = runModelChecked(input({ warningsKept: [{ id: 'run:calibration.noObserved:0', note: 'No gauge yet' }] }));
		expect(b.summary.catchment).toEqual(a.summary.catchment);
		expect(b.summary.calibration).toEqual(a.summary.calibration);
		expect(b.summary.warnings).toEqual(a.summary.warnings);
	});
});
