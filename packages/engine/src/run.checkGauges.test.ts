// A checks-only gauge's record (engine ≥ 1.90.0, issue #554, docs/model.md
// §2.10k): every gauge inside the network with a flow record of its own,
// other than the calibration site, has that record stored as its node's
// `observed_flow_check`, beside its `outflow`, for its hydrograph.
import { describe, expect, it } from 'vitest';
import { CHECK_GAUGE_FLOW_KEY, checkGaugeFlowLabel, gaugeSeriesKey, type ModelInput, type ModelOutput, type NetworkNode } from './project';
import { runModelChecked } from './run';

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
});
