// Plausibility checks 1 and 4 at gauge nodes inside the network (engine ≥
// 1.4.0, docs/model.md §2.10d): an observed record attached to a gauge node
// (a GaugeSeriesKey series) is checked against the simulated flow there,
// reported per site. Synthetic two-gauge network, no client data:
//
//   A (farm, dam, irrigation) → H (gauge) → G (outlet gauge) ← B (farm)
//   C (farm) → K (gauge) → G
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import { gaugeSeriesKey, parseGaugeSeriesKey, type ModelInput, type NetworkNode, type RunSeries } from '../project';
import { runModelWith } from '../run';

const flat = (v: number) => new Array(12).fill(v) as unknown as Monthly;
const days = 730; // water years 2001 and 2002
const startDate = '2001-10-01';
const SEC = 86_400;

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Node ${id}`,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
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
	};
}

const natural = Array.from({ length: days }, (_, t) => 3000 + 2000 * Math.sin((2 * Math.PI * t) / 365));

function base(): ModelInput {
	const nodes = [
		node('A', { downstreamNodeId: 'H', pctRunoffToDam: 1, damCapacityM3: 50_000, damInitialPct: 0.5, damAreaFullM2: 10_000, irrigationEfficiency: 0.5, returnFlowFraction: 0.25 }),
		node('H', { kind: 'gauge', areaKm2: 0, downstreamNodeId: 'G', sortOrder: 1 }),
		node('B', { downstreamNodeId: 'G', sortOrder: 2 }),
		node('C', { downstreamNodeId: 'K', sortOrder: 3 }),
		node('K', { kind: 'gauge', areaKm2: 0, downstreamNodeId: 'G', sortOrder: 4 }),
		node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 5 })
	];
	return {
		settings: { ewrPragmaticM3PerDay: flat(1000), apanMm: flat(150) },
		model: { nodes, crops: [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }], cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 2000 }], transfers: [] },
		series: { rain_catchment_mm: { startDate, values: new Array(days).fill(1) } }
	};
}

const run = (i: ModelInput) => runModelWith(i, () => ({ naturalFlowM3Day: natural }));
const get = (series: RunSeries[], nodeId: string | null, key: string) => series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
/** A simulated flow (m³/day) as an observed record (m³/s), scaled. */
const asRecord = (m3Day: number[], scale = 1) => ({ startDate, values: m3Day.map((v) => (v / SEC) * scale) });

/** The base run, and a copy of its input with the outlet's record = its simulated outflow and each gauge's = its flow × scale. */
function withRecords(scale: { H?: number; K?: number }, kind: 'flow_observed_m3s' | 'flow_logger_m3s' = 'flow_observed_m3s') {
	const first = run(base());
	const i = base();
	i.series.flow_observed_m3s = asRecord(get(first.series, null, 'simulated_outflow'));
	for (const g of ['H', 'K'] as const) if (scale[g] !== undefined) i.series[gaugeSeriesKey(kind, g)] = asRecord(get(first.series, g, 'outflow'), scale[g]);
	return { first, input: i };
}

describe('gauge series keys', () => {
	it('round-trips a kind and a node id, and refuses anything else', () => {
		expect(parseGaugeSeriesKey(gaugeSeriesKey('flow_logger_m3s', 'n-1'))).toEqual({ kind: 'flow_logger_m3s', nodeId: 'n-1' });
		expect(parseGaugeSeriesKey('flow_observed_m3s')).toBeNull();
		expect(parseGaugeSeriesKey('rain_catchment_mm@n-1')).toBeNull();
		expect(parseGaugeSeriesKey('flow_observed_m3s@')).toBeNull();
	});
});

describe('plausibility checks at gauge nodes (engine ≥ 1.4.0)', () => {
	it('a project whose records are all the outlet’s has no gauges block', () => {
		const { input } = withRecords({});
		const out = run(input);
		expect(out.summary.plausibility).toBeDefined();
		expect('gauges' in out.summary.plausibility!).toBe(false);
	});

	it('a gauge record changes nothing but the gauges block, its EWR test (a gauge EWR site, engine ≥ 1.41.0) and its own warnings', () => {
		const without = run(withRecords({}).input);
		const withGauge = run(withRecords({ H: 3 }).input);
		expect(withGauge.series).toEqual(without.series);
		const { gauges, ...rest } = withGauge.summary.plausibility!;
		expect(rest).toEqual(without.summary.plausibility);
		expect(gauges).toHaveLength(1);
		const extra = withGauge.summary.warnings.filter((w) => !without.summary.warnings.includes(w));
		expect(extra.length).toBeGreaterThan(0);
		expect(extra.every((w) => w.startsWith('At gauge "Node H": '))).toBe(true);
		const { plausibility: _a, warnings: _b, catchment: { ewrAgreementSites, ...catchment }, ...summaryRest } = withGauge.summary;
		const { plausibility: _c, warnings: _d, ...summaryRestWithout } = without.summary;
		expect({ ...summaryRest, catchment }).toEqual(summaryRestWithout);
		expect(without.summary.catchment.ewrAgreementSites).toBeUndefined();
		expect(ewrAgreementSites?.map((x) => x.nodeId)).toEqual(['H']);
	});

	it('reports a failing gauge record at its own node (positive control: a matching one passes)', () => {
		// H's record is 3× the simulated flow there: the record implies far more natural flow than
		// the model has above H. K's record is exactly the simulated flow at K.
		const out = run(withRecords({ H: 3, K: 1 }).input);
		const p = out.summary.plausibility!;
		expect(p.gauges!.map((g) => g.nodeId)).toEqual(['H', 'K']);
		const [h, k] = p.gauges!;
		expect(h!.name).toBe('Node H');
		expect(h!.flowKind).toBe('flow_observed_m3s');
		expect(h!.naturalised!.judgedYears).toBe(2);
		expect(h!.naturalised!.failedYears).toEqual([2001, 2002]);
		expect(k!.naturalised!.judgedYears).toBe(2);
		expect(k!.naturalised!.failedYears).toEqual([]);
		// The outlet record is the simulated outflow: the outlet passes too.
		expect(p.naturalised!.failedYears).toEqual([]);
		// Check 4: H's simulated Q90 is a third of its record's; K's matches.
		expect(h!.lowFlow!.comparison!.ratio).toBeCloseTo(1 / 3, 6);
		expect(h!.lowFlow!.comparison!.withinFactor).toBe(false);
		expect(k!.lowFlow!.comparison!.ratio).toBeCloseTo(1, 9);
		expect(k!.lowFlow!.comparison!.withinFactor).toBe(true);
		// The warnings name the gauge; none names K.
		const at = out.summary.warnings.filter((w) => w.startsWith('At gauge'));
		expect(at).toHaveLength(2);
		expect(at[0]).toMatch(/^At gauge "Node H": natural flow below observed \+ abstraction in 2 of 2 water years/);
		expect(at[1]).toMatch(/^At gauge "Node H": dry-season low flows: /);
	});

	it('takes the natural flow above the gauge and the dams above it only', () => {
		const out = run(withRecords({ H: 1, K: 1 }).input);
		const [h, k] = out.summary.plausibility!.gauges!;
		// Flow shares by area: A, B, C 1 km² each; the gauges have none. H sees A's third, K sees C's.
		expect(h!.naturalShare).toBeCloseTo(1 / 3, 12);
		expect(k!.naturalShare).toBeCloseTo(1 / 3, 12);
		const hy = h!.naturalised!.years[0]!;
		const expectNatural = natural.slice(0, 365).reduce((a, v) => a + v / 3, 0) / 1e6;
		expect(hy.naturalMm3).toBeCloseTo(expectNatural, 9);
		// A's dam is above H: its storage change shows there, and not at K (no dam above it).
		expect(hy.damsMm3).not.toBe(0);
		expect(k!.naturalised!.years[0]!.damsMm3).toBe(0);
		// The record equals the simulated flow: the gap is 0 and A = N − S.
		expect(hy.gapMm3).toBeCloseTo(0, 9);
		expect(hy.abstractionMm3).toBeCloseTo(hy.naturalMm3 - hy.observedMm3, 9);
	});

	it('checks the logger when that is the gauge’s only record', () => {
		const out = run(withRecords({ K: 1 }, 'flow_logger_m3s').input);
		const [k] = out.summary.plausibility!.gauges!;
		expect(k!.nodeId).toBe('K');
		expect(k!.flowKind).toBe('flow_logger_m3s');
		expect(k!.naturalised!.flowKind).toBe('flow_logger_m3s');
	});

	it('leaves out, with a warning, a record on a node that is gone, not a gauge, or the outlet', () => {
		const { input } = withRecords({});
		const rec = input.series.flow_observed_m3s!;
		input.series[gaugeSeriesKey('flow_observed_m3s', 'gone')] = rec;
		input.series[gaugeSeriesKey('flow_observed_m3s', 'B')] = rec;
		input.series[gaugeSeriesKey('flow_logger_m3s', 'G')] = rec;
		const out = run(input);
		expect(out.summary.plausibility!.gauges).toBeUndefined();
		// In node-id order: B, G, gone.
		const w = out.summary.warnings.filter((x) => /record is attached to/.test(x));
		expect(w).toEqual([
			expect.stringMatching(/^An observed flow record is attached to "Node B", which is not a gauge/),
			expect.stringMatching(/^An observed flow \(logger\) record is attached to the outlet node "Node G"/),
			expect.stringMatching(/^An observed flow record is attached to a node that is no longer in the model/)
		]);
	});
});
