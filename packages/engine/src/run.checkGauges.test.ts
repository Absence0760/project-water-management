// A checks-only gauge's record (engine ≥ 1.90.0, issue #554, docs/model.md
// §2.10k): every gauge inside the network with a flow record of its own,
// other than the calibration site, has that record stored as its node's
// `observed_flow_check`, beside its `outflow`, for its hydrograph.
import { describe, expect, it } from 'vitest';
import { calibrationStats } from './network/stats';
import { gaugeFitCheck } from './plausibility';
import { CHECK_GAUGE_FLOW_KEY, checkGaugeFlowLabel, gaugeSeriesKey, type CalibrationFlowKind, type ModelInput, type ModelOutput, type NetworkNode } from './project';
import { runModelChecked } from './run';
import { checkGaugeRecords } from './testing/invariants';

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
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

/** A synthetic record between 0.5·scale and 1.5·scale m³/s, blank every 50th day. */
const record = (scale = 1) => ({ startDate: START, values: Array.from({ length: DAYS }, (_, t) => (t % 50 === 7 ? null : scale * (1 + 0.5 * Math.sin((2 * Math.PI * t) / 97)))) });

/** Farms F1 → weir H and F2 → weir K, both draining to the outlet gauge G. */
function input(settings: ModelInput['settings'] = {}, series: ModelInput['series'] = {}): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 }, ...settings },
		model: {
			nodes: [
				node({ id: 'G', name: 'Outlet', kind: 'gauge' }),
				node({ id: 'H', name: 'Upper weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 1 }),
				node({ id: 'K', name: 'Side weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 2 }),
				node({ id: 'F1', name: 'Farm one', downstreamNodeId: 'H', areaKm2: 30, sortOrder: 3 }),
				node({ id: 'F2', name: 'Farm two', downstreamNodeId: 'K', areaKm2: 20, sortOrder: 4 })
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

const at = (out: ModelOutput, key: string, nodeId: string | null) => out.series.find((s) => s.key === key && s.nodeId === nodeId);
const asM3Day = (r: ReturnType<typeof record>) => r.values.map((v) => (v === null ? null : v * 86_400));
// A stored NaN reads as null here, as it serialises.
const plain = (v: ArrayLike<number>) => Array.from(v, (x) => (Number.isNaN(x) ? null : x));

describe('observed_flow_check', () => {
	it('stores each inner gauge’s record beside its outflow, in m³/day with gaps blank, labelled by its instrument', () => {
		const h = record(1);
		const k = record(30);
		const out = runModelChecked(input({}, { [gaugeSeriesKey('flow_observed_m3s', 'H')]: h, [gaugeSeriesKey('flow_logger_m3s', 'K')]: k }));
		const ch = at(out, CHECK_GAUGE_FLOW_KEY, 'H')!;
		const ck = at(out, CHECK_GAUGE_FLOW_KEY, 'K')!;
		expect(ch.label).toBe(checkGaugeFlowLabel('flow_observed_m3s'));
		expect(ck.label).toBe(checkGaugeFlowLabel('flow_logger_m3s'));
		expect(ch.unit).toBe('m³/day');
		expect(plain(ch.values)).toEqual(asM3Day(h));
		expect(plain(ck.values)).toEqual(asM3Day(k));
		// Beside the gauge's own simulated flow.
		expect(at(out, 'outflow', 'H')?.values).toHaveLength(out.days);
		// Not the calibration site's key: no node-scoped observed_flow, so the run still scores the outlet.
		expect(out.series.filter((s) => s.key === 'observed_flow' && s.nodeId !== null)).toEqual([]);
		expect(out.summary.calibration?.siteNodeId ?? null).toBeNull();
		// The self-checks read the record's blank days as gaps (verify/checks.ts GAPPY_SERIES), not as a failed series.
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
	});

	it('leaves the calibration site out (its record is its observed_flow) and keeps the other gauge’s', () => {
		const out = runModelChecked(
			input({ calibrationSiteNodeId: 'H' }, { [gaugeSeriesKey('flow_observed_m3s', 'H')]: record(1), [gaugeSeriesKey('flow_observed_m3s', 'K')]: record(2) })
		);
		expect(at(out, CHECK_GAUGE_FLOW_KEY, 'H')).toBeUndefined();
		expect(at(out, 'observed_flow', 'H')).toBeDefined();
		expect(at(out, CHECK_GAUGE_FLOW_KEY, 'K')).toBeDefined();
	});

	it('picks the outlet record’s kind when the gauge has both records, as the plausibility checks there do (the gauge record without one)', () => {
		const both = { [gaugeSeriesKey('flow_observed_m3s', 'H')]: record(1), [gaugeSeriesKey('flow_logger_m3s', 'H')]: record(3) };
		const logger = runModelChecked(input({ calibrationFlowKind: 'flow_logger_m3s' }, { ...both, flow_logger_m3s: record(5) }));
		expect(at(logger, CHECK_GAUGE_FLOW_KEY, 'H')!.label).toBe(checkGaugeFlowLabel('flow_logger_m3s'));
		expect(logger.summary.plausibility?.gauges?.find((g) => g.nodeId === 'H')?.flowKind).toBe('flow_logger_m3s');
		// Positive control: without a kind asked for, the gauge record.
		const gauge = runModelChecked(input({}, both));
		expect(at(gauge, CHECK_GAUGE_FLOW_KEY, 'H')!.label).toBe(checkGaugeFlowLabel('flow_observed_m3s'));
	});

	it('stores nothing without an inner gauge record, nor for a record on the outlet or on a unit', () => {
		const none = runModelChecked(input({}, { flow_observed_m3s: record(1) }));
		expect(none.series.filter((s) => s.key === CHECK_GAUGE_FLOW_KEY)).toEqual([]);
		const misplaced = runModelChecked(input({}, { [gaugeSeriesKey('flow_observed_m3s', 'G')]: record(1), [gaugeSeriesKey('flow_observed_m3s', 'F1')]: record(1) }));
		expect(misplaced.series.filter((s) => s.key === CHECK_GAUGE_FLOW_KEY)).toEqual([]);
	});

	it('one record per gauge (engine-audit.md G2): the EWR test, the plausibility checks and the checks-only series read the same one', () => {
		const both = (nodeId: string) => ({ [gaugeSeriesKey('flow_observed_m3s', nodeId)]: record(1), [gaugeSeriesKey('flow_logger_m3s', nodeId)]: record(2) });
		const kinds = (out: ModelOutput, nodeId: string) => ({
			plausibility: out.summary.plausibility?.gauges?.find((x) => x.nodeId === nodeId)?.flowKind,
			ewr: out.summary.catchment.ewrAgreementSites?.find((x) => x.nodeId === nodeId)?.flowKind,
			series: at(out, CHECK_GAUGE_FLOW_KEY, nodeId)?.label
		});
		const all = (kind: CalibrationFlowKind) => ({ plausibility: kind, ewr: kind, series: checkGaugeFlowLabel(kind) });
		// The outlet has only a logger and no kind is asked for: the run scores the logger, so every check at a gauge reads
		// its logger. Before 1.90.0 the EWR test read the gauge record here.
		const loggerOutlet = runModelChecked(input({}, { ...both('H'), ...both('K'), flow_logger_m3s: record(1) }));
		expect(loggerOutlet.summary.calibration?.flowKind).toBe('flow_logger_m3s');
		for (const g of ['H', 'K']) expect(kinds(loggerOutlet, g), g).toEqual(all('flow_logger_m3s'));
		// Positive control: an outlet gauge record, every check on the gauges' gauge records.
		const gaugeOutlet = runModelChecked(input({}, { ...both('H'), ...both('K'), flow_observed_m3s: record(1) }));
		for (const g of ['H', 'K']) expect(kinds(gaugeOutlet, g), g).toEqual(all('flow_observed_m3s'));
		// Scored at a calibration site (no outlet record), its logger asked for: the other gauge is checked on its logger too.
		const atSite = runModelChecked(input({ calibrationSiteNodeId: 'H', calibrationFlowKind: 'flow_logger_m3s' }, { ...both('H'), ...both('K') }));
		expect(atSite.summary.calibration?.flowKind).toBe('flow_logger_m3s');
		expect(kinds(atSite, 'K')).toEqual(all('flow_logger_m3s'));
		expect(atSite.summary.plausibility?.gauges?.find((x) => x.nodeId === 'H')?.flowKind).toBe('flow_logger_m3s');
		// Nothing scored (no outlet record, no site) and the logger asked for: the gauges are checked on what was asked for.
		const unscored = runModelChecked(input({ calibrationFlowKind: 'flow_logger_m3s' }, { ...both('H'), ...both('K') }));
		expect(unscored.summary.calibration?.flowKind ?? null).toBeNull();
		for (const g of ['H', 'K']) expect(kinds(unscored, g), g).toEqual(all('flow_logger_m3s'));
	});

	it('keeps each gauge’s fit in the summary, from the stored record and its simulated flow, the calibration exclusions left out', () => {
		const exclusions = [{ start: '2020-01-01', end: '2020-03-31', reason: 'Weir silted up' }];
		const out = runModelChecked(input({ calibrationExclusions: exclusions as never }, { [gaugeSeriesKey('flow_observed_m3s', 'H')]: record(1), [gaugeSeriesKey('flow_observed_m3s', 'K')]: record(30) }));
		for (const g of ['H', 'K']) {
			const fit = out.summary.plausibility!.gauges!.find((x) => x.nodeId === g)!.fit!;
			const obs = Array.from(at(out, CHECK_GAUGE_FLOW_KEY, g)!.values, (v) => (Number.isNaN(v) ? null : v / 86_400));
			const ref = calibrationStats(at(out, 'outflow', g)!.values, obs, { startDate: START, exclusions });
			// The same days and, up to the m³/s ↔ m³/day round trip of the stored record, the same numbers.
			expect(fit.days, g).toBe(ref.days);
			for (const k of ['nse', 'kge', 'pbias'] as const) expect(fit[k], `${g} ${k}`).toBeCloseTo(ref[k]!, 9);
			expect(ref.excludedDays, g).toBeGreaterThan(0);
		}
		// The 30× record reads as a unit error at a glance.
		expect(out.summary.plausibility!.gauges!.find((x) => x.nodeId === 'K')!.fit!.pbias!).toBeGreaterThan(90);
	});
	it('leaves a forecast run’s forecast days out of the fit, as the flow-duration curves beside it are cut (engine-audit.md K1)', () => {
		const TAIL = 60;
		// A record that runs on into the forecast days (a pre-filled series): those days must not be scored.
		const long = { startDate: START, values: Array.from({ length: DAYS + TAIL }, (_, t) => (t % 50 === 7 ? null : 1 + 0.5 * Math.sin((2 * Math.PI * t) / 97))) };
		const base = input({}, { [gaugeSeriesKey('flow_observed_m3s', 'H')]: long });
		const forecast = runModelChecked({
			...base,
			series: { ...base.series, rain_forecast_mm: { startDate: '2021-09-30', values: Array.from({ length: TAIL }, (_, t) => (t % 7 === 0 ? 10 : 0)) } }
		});
		expect(forecast.days).toBe(DAYS + TAIL);
		expect(forecast.summary.historyDays).toBe(DAYS);
		const read = long.values.slice(0, DAYS).filter((v) => v !== null).length;
		expect(forecast.summary.plausibility!.gauges!.find((x) => x.nodeId === 'H')!.fit!.days).toBe(read);
		// Positive control: the same record in a run without a forecast is scored on all its days in the run.
		const plain = runModelChecked(input({}, { [gaugeSeriesKey('flow_observed_m3s', 'H')]: long }));
		expect(plain.summary.plausibility!.gauges!.find((x) => x.nodeId === 'H')!.fit!.days).toBe(read);
	});
});

describe('checkGaugeRecords (engine-audit.md G2)', () => {
	it('holds over every mix of outlet records, the kind asked for, a calibration site and the gauges’ records', () => {
		type Kinds = 'gauge' | 'logger' | 'both';
		const recs = (k: Kinds, nodeId: string | null, scale: number) => {
			const key = (kind: CalibrationFlowKind) => (nodeId ? gaugeSeriesKey(kind, nodeId) : kind);
			return {
				...(k !== 'logger' ? { [key('flow_observed_m3s')]: record(scale) } : {}),
				...(k !== 'gauge' ? { [key('flow_logger_m3s')]: record(scale * 1.3) } : {})
			};
		};
		let runs = 0;
		for (const outlet of [null, 'gauge', 'logger', 'both'] as const)
			for (const wanted of [undefined, 'flow_observed_m3s', 'flow_logger_m3s'] as const)
				for (const site of [null, 'H'] as const)
					for (const h of ['gauge', 'logger', 'both'] as const)
						for (const k of ['gauge', 'both'] as const) {
							const out = runModelChecked(
								input(
									{ ...(wanted ? { calibrationFlowKind: wanted } : {}), ...(site ? { calibrationSiteNodeId: site } : {}) },
									{ ...(outlet ? recs(outlet, null, 2) : {}), ...recs(h, 'H', 1), ...recs(k, 'K', 0.5) }
								)
							);
							const label = JSON.stringify({ outlet, wanted, site, h, k });
							expect(checkGaugeRecords(out), label).toBeNull();
							// Positive control that the check has something to check: both gauges are reached.
							expect(out.summary.plausibility?.gauges?.length, label).toBe(2);
							runs++;
						}
		expect(runs).toBe(144);
	});

	it('catches a reader that strays (positive control)', () => {
		const out = runModelChecked(input({}, { [gaugeSeriesKey('flow_observed_m3s', 'H')]: record(1), [gaugeSeriesKey('flow_logger_m3s', 'H')]: record(2) }));
		expect(checkGaugeRecords(out)).toBeNull();
		const g = out.summary.plausibility!.gauges![0]!;
		const stray = { ...out, summary: { ...out.summary, plausibility: { ...out.summary.plausibility!, gauges: [{ ...g, flowKind: 'flow_logger_m3s' as const }] } } };
		expect(checkGaugeRecords(stray)).toMatch(/^gauge H: /);
	});
});

describe('gaugeFitCheck', () => {
	it('scores the read days only, with the calibration statistics’ formulas', () => {
		const sim = [1.2, 9, 1.8, 9, 3.3, 3.5].map((v) => v * 86_400);
		const obs = [1, null, 2, null, 3, 4];
		const ref = calibrationStats(sim, obs);
		expect(gaugeFitCheck(sim, obs, null)).toEqual({ days: 4, nse: ref.nse, kge: ref.kge, pbias: ref.pbias });
		// A perfect match on the read days scores 1, whatever the unread days hold.
		const perfect = gaugeFitCheck([1, 9, 2, 9, 3, 4].map((v) => v * 86_400), obs, null)!;
		expect(perfect.nse).toBeCloseTo(1, 12);
		expect(perfect.pbias).toBeCloseTo(0, 12);
	});

	it('leaves the excluded days out, and is null with no day read', () => {
		const sim = [1, 1, 1, 1].map((v) => v * 86_400);
		expect(gaugeFitCheck(sim, [1, 1, 50, 1], Uint8Array.from([0, 0, 1, 0]))).toEqual({ days: 3, nse: null, kge: null, pbias: 0 });
		expect(gaugeFitCheck(sim, [null, null, null, null], null)).toBeNull();
	});

	it('leaves the days from historyDays on out (a forecast run’s forecast)', () => {
		const sim = [1, 1, 1, 1].map((v) => v * 86_400);
		expect(gaugeFitCheck(sim, [1, 1, 50, 50], null, 2)).toEqual({ days: 2, nse: null, kge: null, pbias: 0 });
		expect(gaugeFitCheck(sim, [1, 1, 50, 50], null)!.days).toBe(4);
	});
});
