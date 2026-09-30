// Calibrating at a gauge inside the network (engine ≥ 1.41.0,
// settings.calibrationSiteNodeId, docs/model.md §2.10k).
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { gaugeSeriesKey, type ModelInput, type NetworkNode } from '../project';
import { mergeSettings } from '../prepare';
import { Rng } from '../random';
import { runModel, runModelWithoutChecks } from '../run';
import type { Gr4jSettings } from '../project';
import { ensembleContext, ensembleMembers, memberInput, memberScores, resolveEnsembleOptions } from '../uncertainty/ensemble';
import { calibrate, prepareCalibration, siteNote } from './calibrate';
import { planAutoCalibration } from './auto';
import { calibrationFitStatus, fitRecordFromReport, fitRecordStatus, fitRecordCaveats } from './provenance';
import { calibrationSiteError, calibrationSites } from './site';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
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

function rain(days: number, start: string, seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(start);
	return Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		const wet = [5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08;
		return rng.bool(wet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}

const TRUTH: Gr4jSettings = { x1: 520, x2: 0, x3: 110, x4: 2.3, warmupDays: 365 };
const START = '1990-10-01';

/**
 * Farm A (40 km²) drains to the inner gauge H, which drains to the outlet G;
 * farm B (60 km²) drains straight to G. H's record is its simulated outflow
 * under TRUTH; the outlet's record (when asked) is the outlet's under another
 * parameter set, so a fit at the wrong site can't reach the truth.
 */
function network(opts: { outletRecord?: boolean; loggerAtH?: boolean } = {}): ModelInput {
	const days = Math.round(6 * 365.25);
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...TRUTH } },
		model: {
			nodes: [
				node({ id: 'G', name: 'Outlet', kind: 'gauge' }),
				node({ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 1 }),
				node({ id: 'K', name: 'Bare gauge', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 2 }),
				node({ id: 'A', name: 'Farm A', downstreamNodeId: 'H', areaKm2: 40, sortOrder: 3 }),
				node({ id: 'B', name: 'Farm B', downstreamNodeId: 'G', areaKm2: 60, sortOrder: 4 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: rain(days, START, 11) } }
	};
	const at = (out: ReturnType<typeof runModel>, nodeId: string | null, key: string) => out.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
	const truth = runModel(input);
	input.series[gaugeSeriesKey('flow_observed_m3s', 'H')] = { startDate: START, values: at(truth, 'H', 'outflow').map((q) => q / 86_400) };
	if (opts.loggerAtH) input.series[gaugeSeriesKey('flow_logger_m3s', 'H')] = { startDate: START, values: at(truth, 'H', 'outflow').map((q) => (q * 1.02) / 86_400) };
	if (opts.outletRecord) {
		const other = runModel({ ...input, settings: { ...input.settings, gr4j: { x1: 150, x2: 0, x3: 40, x4: 1.1, warmupDays: 365 } } });
		input.series.flow_observed_m3s = { startDate: START, values: at(other, null, 'simulated_outflow').map((q) => q / 86_400) };
	}
	input.settings.gr4j = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };
	return input;
}
const atSite = (input: ModelInput, site: string | null): ModelInput => ({ ...input, settings: { ...input.settings, calibrationSiteNodeId: site } });

describe('calibration sites', () => {
	it('settings: null by default; anything but a node id falls back to the outlet, with a warning', () => {
		expect(mergeSettings({}, []).calibrationSiteNodeId).toBeNull();
		expect(mergeSettings({ calibrationSiteNodeId: 'H' }, []).calibrationSiteNodeId).toBe('H');
		for (const bad of [5, '', {}]) {
			const warnings: string[] = [];
			expect(mergeSettings({ calibrationSiteNodeId: bad } as never, warnings).calibrationSiteNodeId).toBeNull();
			expect(warnings.some((w) => w.includes('calibrating at the outlet'))).toBe(true);
		}
	});

	it('lists the inner gauges with a record, never the outlet or a gauge without one', () => {
		const input = network({ outletRecord: true, loggerAtH: true });
		expect(calibrationSites(input.model, input.series)).toEqual([{ nodeId: 'H', name: 'Weir', records: ['flow_observed_m3s', 'flow_logger_m3s'] }]);
	});

	it('refuses a site that is gone, not a gauge, or the outlet, and a gauge without a record', () => {
		const input = network({ outletRecord: true });
		const { nodes } = input.model;
		expect(calibrationSiteError(nodes, 0, 'gone')).toMatch(/no longer in the model/);
		expect(calibrationSiteError(nodes, 0, 'A')).toMatch(/"Farm A" is not a gauge/);
		expect(calibrationSiteError(nodes, 0, 'G')).toMatch(/is the outlet/);
		expect(calibrationSiteError(nodes, 0, 'H')).toBeNull();
		expect(() => prepareCalibration(atSite(input, 'gone'))).toThrow(/no longer in the model/);
		expect(() => prepareCalibration(atSite(input, 'K'))).toThrow(/no observed flow record at the calibration site "Bare gauge"/);
	});

	it('null is the outlet: the default changes nothing', () => {
		const input = network({ outletRecord: true });
		const a = prepareCalibration(input);
		const b = prepareCalibration(atSite(input, null));
		expect(b.siteNodeId).toBeNull();
		expect(b.flowKind).toBe(a.flowKind);
		expect([...b.observed]).toEqual([...a.observed]);
		expect([...b.simulate(TRUTH as never)]).toEqual([...a.simulate(TRUTH as never)]);
		// Without an outlet record, the outlet has nothing to fit, as before; the gauge does.
		expect(() => prepareCalibration(network())).toThrow(/no observed flow series to calibrate against/);
		expect(prepareCalibration(atSite(network(), 'H')).flowKind).toBe('flow_observed_m3s');
	});

	it('scores the gauge’s own simulated flow against the gauge’s record', () => {
		const input = atSite(network({ outletRecord: true }), 'H');
		const pb = prepareCalibration(input);
		expect(pb.siteNodeId).toBe('H');
		expect(pb.records).toEqual(['flow_observed_m3s']);
		const out = runModel({ ...input, settings: { ...input.settings, gr4j: TRUTH } });
		const h = out.series.find((s) => s.nodeId === 'H' && s.key === 'outflow')!.values;
		const sim = pb.simulate({ ...TRUTH } as never);
		for (const t of pb.scoredDays) {
			expect(sim[t]).toBeCloseTo(h[t]!, 6);
			expect(pb.observed[t]).toBeCloseTo(h[t]!, 6);
		}
	});

	it('fits at the gauge, records the site, and a fit at the outlet cannot reach the gauge’s truth', { timeout: 60_000 }, () => {
		const input = atSite(network({ outletRecord: true }), 'H');
		const r = calibrate(input, { budget: 400, validate: false, seed: 3 });
		expect(r.siteNodeId).toBe('H');
		expect(r.fit.scores.kgePrime).toBeGreaterThan(0.97);
		expect(r.notes).toContain(siteNote('Weir'));
		const outlet = calibrate(atSite(input, null), { budget: 400, validate: false, seed: 3 });
		expect(outlet.siteNodeId).toBeNull();
		expect(outlet.notes).not.toContain(siteNote('Weir'));
		// Each fit's parameters score worse at the other site.
		expect(Math.abs(outlet.params.x1! - TRUTH.x1)).toBeGreaterThan(Math.abs(r.params.x1! - TRUTH.x1));

		const record = fitRecordFromReport(r, {
			settings: { ...input.settings, calibrationStart: null, calibrationEnd: null, panCoefficient: [], apanMm: apan, chirpsBiasCorrection: 'monthly' } as never,
			validate: false,
			validationRecord: null,
			engineVersion: 'test',
			fittedAt: '2026-09-30T00:00:00.000Z'
		});
		expect(record.siteNodeId).toBe('H');
		expect(record.flowGapFill).toEqual({ spec: null });
		const settings = { ...input.settings, gr4j: { ...record.params, warmupDays: 365 }, fitRecord: record } as never;
		expect(fitRecordStatus({ ...(settings as object), calibrationSiteNodeId: 'H' }, record).siteChanged).toBe(false);
		const moved = fitRecordStatus({ ...(settings as object), calibrationSiteNodeId: null }, record);
		expect(moved.siteChanged).toBe(true);
		expect(fitRecordCaveats(moved)).toContain('The calibration site has changed since the fit, so it was fitted to another gauge’s record.');
		// A record from before the site existed was fitted at the outlet.
		const { siteNodeId: _drop, ...old } = record;
		expect(fitRecordStatus({ calibrationSiteNodeId: null }, old).siteChanged).toBe(false);
		// The run's statistics are the outlet's, so a fit at a gauge isn't in-sample there.
		expect(calibrationFitStatus({ ...(settings as object), calibrationSiteNodeId: 'H' } as never, 'flow_observed_m3s')).toBe('otherPeriod');
		expect(calibrationFitStatus({ ...(settings as object), calibrationSiteNodeId: 'H' } as never, 'flow_observed_m3s', 'H')).toBe('fitted');
	});

	it('a gauge’s record has no gauged range: the outlet records’ ratings don’t flag its days', () => {
		const rated = (i: ModelInput): ModelInput => ({
			...i,
			settings: { ...i.settings, qualityFlags: { ratings: { flow_observed_m3s: { gaugedMaxM3s: 0.001, gaugedMinM3s: null, source: 'test' } } } } as never
		});
		const outlet = prepareCalibration(rated(network({ outletRecord: true })));
		expect(outlet.dayQuality!.flow.aboveRating).toBeGreaterThan(0);
		const gauge = prepareCalibration(rated(atSite(network({ outletRecord: true }), 'H')));
		expect(gauge.dayQuality!.flow.aboveRating).toBe(0);
		expect(gauge.censor ?? null).toBeNull();
	});

	it('validates against the other record at the same gauge, and says when the gauge has none', { timeout: 60_000 }, () => {
		const both = atSite(network({ outletRecord: true, loggerAtH: true }), 'H');
		const r = calibrate(both, { budget: 200, validate: false, seed: 1, validationRecord: 'flow_logger_m3s' });
		expect(r.independentRecord?.flowKind).toBe('flow_logger_m3s');
		expect(r.independentRecord!.validation.scores.kgePrime).toBeGreaterThan(0.9);
		const one = atSite(network({ outletRecord: true }), 'H');
		const n = calibrate(one, { budget: 100, validate: false, seed: 1, validationRecord: 'flow_logger_m3s' });
		expect(n.independentRecord).toBeNull();
		expect(n.notes.some((x) => x.startsWith('The calibration site has no logger'))).toBe(true);
	});

	it('automated calibration and the ensemble follow the site', () => {
		const input = atSite(network({ outletRecord: true, loggerAtH: true }), 'H');
		const plan = planAutoCalibration(input);
		expect(plan.siteNodeId).toBe('H');
		expect(plan.validationRecord).toBe('flow_logger_m3s');

		const truthIn = { ...input, settings: { ...input.settings, gr4j: { ...TRUTH } } };
		const { options } = resolveEnsembleOptions(truthIn, { model: 'gr4j', seed: 1 });
		expect(options.records).toEqual(['flow_observed_m3s', 'flow_logger_m3s']);
		const ctx = ensembleContext(truthIn, options);
		expect(ctx.siteNodeId).toBe('H');
		const ref = ensembleMembers(options, ctx.startParams)[0]!;
		const s = memberScores(ctx, ref, runModelWithoutChecks(memberInput(ctx, ref)));
		// The reference member runs the truth, so at the gauge it matches its record.
		expect(s.skill).toBeGreaterThan(0.99);
	});
});
