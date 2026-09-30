import { describe, expect, it } from 'vitest';
import { withMonthlyRates } from './network/transferRates';
import {
	compareRuns,
	describeCalendarMonths,
	describeFitRecord,
	diffInputs,
	sharedDaysChange,
	matchByIdThenName,
	metricDelta,
	nodeChangeFields,
	peText,
	settingsChangePaths,
	type ComparableRun,
	type RunInputsSnapshot
} from './compare';
import { defaultProjectSettings, type FarmSummary, type NetworkNode, type RunSummary, type ZeroRainSettings } from './project';
import { ewrAgreement } from './network/ewrAgreement';
import { assessSite } from './reserve/assurance';
import type { EwrRuleTable } from './reserve/rules';

/** The accumulation fields as a run saved before engine 0.20.0 ran them: as recorded. */
const ACC: Pick<ZeroRainSettings, 'accumulationMode' | 'keepReadings' | 'addAccumulations'> = { accumulationMode: 'asRecorded', keepReadings: [], addAccumulations: [] };

// Synthetic catchment — invented names and values only (public repo).

function farm(nodeId: string, name: string, over: Partial<FarmSummary> = {}): FarmSummary {
	return {
		nodeId,
		name,
		avgDemandM3Day: 1000,
		avgSuppliedM3Day: 900,
		avgDeficitM3Day: 100,
		fractionSupplied: 0.9,
		avgEwrShortfallM3Day: 50,
		daysEwrNotMet: 10,
		...over
	};
}

function summary(farms: FarmSummary[], over: Partial<RunSummary> = {}): RunSummary {
	return {
		farms,
		catchment: { meanNaturalFlowM3Day: 50_000, meanSimulatedOutflowM3Day: 40_000, ewrDaysNotMet: 100, ewrFractionDaysNotMet: 0.1 },
		calibration: null,
		warnings: [],
		...over
	};
}

function run(s: RunSummary, over: Partial<ComparableRun> = {}): ComparableRun {
	return { engineVersion: '0.2.0', startDate: '2000-01-01', endDate: '2020-12-31', summary: s, ...over };
}

function node(id: string, name: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name,
		kind: 'farm',
		downstreamNodeId: 'g',
		sortOrder: 0,
		areaKm2: 10,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0.5,
		damCapacityM3: 600_000,
		damInitialPct: 0.5,
		damMinPct: 0.1,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 0.8,
		lossReturnFraction: 0.5,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

function snapshot(over: Partial<RunInputsSnapshot> = {}): RunInputsSnapshot {
	return {
		settings: defaultProjectSettings() as unknown as RunInputsSnapshot['settings'],
		model: {
			nodes: [node('g', 'Outlet', { kind: 'gauge', downstreamNodeId: null, damCapacityM3: 0 }), node('f1', 'Rooikloof'), node('f2', 'Bergwater')],
			crops: [{ id: 'c1', name: 'Citrus', cropFactor: new Array(12).fill(0.7) }],
			cropAreas: [{ nodeId: 'f1', cropId: 'c1', areaM2: 200_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2000-01-01', length: 366 } },
		...over
	};
}

/**
 * A run saved on the legacy runoff model (engine < 1.0.0): its settings carry
 * the model's own calibration keys, which runs today no longer have.
 */
function legacySnapshot(): RunInputsSnapshot {
	const s = snapshot();
	const settings = s.settings as unknown as Record<string, unknown>;
	settings.runoffModel = 'legacy';
	settings.calibration = {
		...(settings.calibration as object),
		a: 0.1,
		b: 1.3,
		summerFactor: 0.2,
		winterFactor: 0.9,
		summerMonths: [10, 11, 12, 1, 2],
		baseFlowInitial: 250,
		recessionFactors: Array.from({ length: 80 }, (_, i) => +(0.3 + 0.68 * (1 - Math.exp(-i / 12))).toFixed(4))
	};
	return s;
}

/** Structured clone with fresh ids everywhere, like POST /projects/:id/copy. */
function copyWithFreshIds(s: RunInputsSnapshot): RunInputsSnapshot {
	const c = structuredClone(s);
	const ids = new Map<string, string>();
	const fresh = (id: string) => {
		if (!ids.has(id)) ids.set(id, `copy-${id}`);
		return ids.get(id)!;
	};
	for (const n of c.model.nodes) {
		n.id = fresh(n.id);
		n.downstreamNodeId = n.downstreamNodeId && fresh(n.downstreamNodeId);
	}
	for (const cr of c.model.crops) cr.id = fresh(cr.id);
	for (const a of c.model.cropAreas) {
		a.nodeId = fresh(a.nodeId);
		a.cropId = fresh(a.cropId);
	}
	for (const t of c.model.transfers) {
		t.id = fresh(t.id);
		t.fromNodeId = fresh(t.fromNodeId);
		t.toNodeId = fresh(t.toNodeId);
	}
	return c;
}

const texts = (a: RunInputsSnapshot, b: RunInputsSnapshot) => diffInputs(a, b).map((c) => c.text);

describe('metricDelta', () => {
	it('is b − a, null when either side is missing or not finite', () => {
		expect(metricDelta(10, 15)).toEqual({ a: 10, b: 15, delta: 5 });
		expect(metricDelta(null, 3)).toEqual({ a: null, b: 3, delta: null });
		expect(metricDelta(NaN, 3).delta).toBeNull();
		expect(metricDelta(undefined, undefined)).toEqual({ a: null, b: null, delta: null });
	});
});

describe('matchByIdThenName', () => {
	const id = (x: { id: string }) => x.id;
	const name = (x: { name: string }) => x.name;

	it('prefers ids, then falls back to trimmed case-insensitive names', () => {
		const a = [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta ' }, { id: '3', name: 'Gone' }];
		const b = [{ id: '9', name: 'beta' }, { id: '1', name: 'Alpha renamed' }, { id: '8', name: 'New' }];
		const m = matchByIdThenName(a, b, id, name);
		expect(m.pairs.map(([x, y]) => `${x.id}:${y.id}`)).toEqual(['2:9', '1:1']); // B's order
		expect(m.onlyA.map(id)).toEqual(['3']);
		expect(m.onlyB.map(id)).toEqual(['8']);
	});

	it('does not reuse an item already matched by id for a name match', () => {
		const a = [{ id: '1', name: 'X' }, { id: '2', name: 'X' }];
		const b = [{ id: '1', name: 'X' }];
		const m = matchByIdThenName(a, b, id, name);
		expect(m.pairs).toHaveLength(1);
		expect(m.onlyA.map(id)).toEqual(['2']);
	});
});

describe('compareRuns', () => {
	it('matches farms by name across projects (different node ids) and computes b − a', () => {
		const a = run(summary([farm('a1', 'Rooikloof'), farm('a2', 'Bergwater')]));
		const b = run(
			summary([
				farm('b2', 'Bergwater'),
				farm('b1', 'Rooikloof', { avgSuppliedM3Day: 980, avgDeficitM3Day: 20, fractionSupplied: 0.98, daysEwrNotMet: 4 })
			])
		);
		const c = compareRuns(a, b);
		expect(c.farms.map((f) => f.name)).toEqual(['Bergwater', 'Rooikloof']);
		const r = c.farms.find((f) => f.name === 'Rooikloof')!;
		expect(r.nodeIdA).toBe('a1');
		expect(r.nodeIdB).toBe('b1');
		expect(r.suppliedM3Day).toEqual({ a: 900, b: 980, delta: 80 });
		expect(r.deficitM3Day.delta).toBe(-80);
		expect(r.fractionSupplied.delta).toBeCloseTo(0.08, 10);
		expect(r.daysEwrNotMet.delta).toBe(-6);
		expect(r.nameA).toBeNull();
		expect(c.onlyInA).toEqual([]);
		expect(c.onlyInB).toEqual([]);
	});

	it('compares the WR2012 ratios when either run has the check, else null', () => {
		expect(compareRuns(run(summary([])), run(summary([]))).wr2012).toBeNull();
		const w = (overlapRatio: number | null, whole: number) =>
			({
				overlap: overlapRatio === null ? null : { years: [2001], simulatedMarMm3: 1, ratio: overlapRatio },
				whole: { days: 365, simulatedMarMm3: 1, ratio: whole },
				lowFlowRatio: 0.8,
				patternCorrelation: 0.9
			}) as unknown as RunSummary['wr2012'];
		const c = compareRuns(run(summary([], { wr2012: w(1.3, 1.25) })), run(summary([], { wr2012: w(1.05, 1.02) })));
		expect(c.wr2012!.marRatioOverlap.a).toBe(1.3);
		expect(c.wr2012!.marRatioOverlap.delta).toBeCloseTo(-0.25, 12);
		expect(c.wr2012!.marRatioWhole.delta).toBeCloseTo(-0.23, 12);
		expect(c.wr2012!.lowFlowRatio.delta).toBe(0);
		const one = compareRuns(run(summary([])), run(summary([], { wr2012: w(null, 1.1) })));
		expect(one.wr2012!.marRatioOverlap).toEqual({ a: null, b: null, delta: null });
		expect(one.wr2012!.marRatioWhole).toEqual({ a: null, b: 1.1, delta: null });
	});

	it('lists farms present in only one run and totals over each run’s own farms', () => {
		const a = run(summary([farm('1', 'Rooikloof'), farm('2', 'Old farm', { avgDemandM3Day: 500, avgSuppliedM3Day: 500, avgDeficitM3Day: 0, fractionSupplied: 1 })]));
		const b = run(summary([farm('1', 'Rooikloof'), farm('3', 'New farm', { avgDemandM3Day: 2000, avgSuppliedM3Day: 1000, avgDeficitM3Day: 1000, fractionSupplied: 0.5 })]));
		const c = compareRuns(a, b);
		expect(c.farms.map((f) => f.name)).toEqual(['Rooikloof']);
		expect(c.onlyInA.map((f) => f.name)).toEqual(['Old farm']);
		expect(c.onlyInB.map((f) => f.name)).toEqual(['New farm']);
		expect(c.totals.demandM3Day).toEqual({ a: 1500, b: 3000, delta: 1500 });
		expect(c.totals.fractionSupplied.a).toBeCloseTo(1400 / 1500);
		expect(c.totals.fractionSupplied.b).toBeCloseTo(1900 / 3000);
		expect(c.totals.farmsBelowTarget).toEqual({ a: 1, b: 2, delta: 1 });
	});

	it('keeps a renamed farm matched by id in the same project', () => {
		const c = compareRuns(run(summary([farm('1', 'Farm 1')])), run(summary([farm('1', 'Rooikloof')])));
		expect(c.farms).toHaveLength(1);
		expect(c.farms[0]).toMatchObject({ name: 'Rooikloof', nameA: 'Farm 1' });
	});

	it('computes catchment and calibration deltas, and flags period / engine differences', () => {
		const cal = { days: 3000, nse: 0.4, pbias: 12, rmseM3s: 0.5, meanObservedM3s: 1, meanSimulatedM3s: 1.1 };
		const a = run(summary([], { calibration: cal }));
		const b = run(
			summary([], {
				catchment: { meanNaturalFlowM3Day: 50_000, meanSimulatedOutflowM3Day: 38_000, ewrDaysNotMet: 150, ewrFractionDaysNotMet: 0.15 },
				calibration: { ...cal, nse: 0.55, pbias: 8 }
			}),
			{ endDate: '2025-04-12', engineVersion: '0.3.0' }
		);
		const c = compareRuns(a, b);
		expect(c.catchment.meanSimulatedOutflowM3Day.delta).toBe(-2000);
		expect(c.catchment.ewrDaysNotMet.delta).toBe(50);
		expect(c.catchment.ewrFractionDaysNotMet.delta).toBeCloseTo(0.05);
		expect(c.calibration!.nse.delta).toBeCloseTo(0.15);
		expect(c.calibration!.pbias.delta).toBe(-4);
		expect(c.samePeriod).toBe(false);
		expect(c.engineVersionChanged).toBe(true);
	});

	it('notes when the CHIRPS fallback factors or the water years left out of the fit differ', () => {
		const corr = (factor: number, excluded: number[], mode: 'monthly' | 'none' = 'monthly'): NonNullable<RunSummary['chirpsCorrection']> => ({
			mode, minDays: 90, minMm: 50, clampMin: 0.25, clampMax: 4,
			pooled: { days: 1000, catchmentMm: 2000, chirpsMm: 1000, ownFactor: factor, factor, clamped: false },
			excludedWaterYears: excluded,
			months: Array.from({ length: 12 }, (_, i) => ({
				month: i + 1, days: 100, catchmentMm: 200, chirpsMm: 100, ownFactor: factor, factor, source: 'month' as const, clamped: false, fallbackDays: 0
			})),
			fallbackDays: 0, correctedDays: 0, fallbackRawMm: 0, fallbackCorrectedMm: 0
		});
		const with_ = (c: RunSummary['chirpsCorrection']) => run(summary([], { chirpsCorrection: c }));
		// Same fit: nothing to note (positive control for "changed").
		expect(compareRuns(with_(corr(2, [1999])), with_(corr(2, [1999]))).chirpsFit).toEqual({
			pooledFactor: { a: 2, b: 2, delta: 0 }, excludedWaterYearsA: [1999], excludedWaterYearsB: [1999],
			// A run without a fit period (before engine 0.29.0) fitted the whole record.
			fitPeriodA: 'whole record', fitPeriodB: 'whole record', segmentsA: [], segmentsB: [], fitWindowsA: [], fitWindowsB: [], changed: false
		});
		// A keep-dry that returns a year to the fit moves both.
		const moved = compareRuns(with_(corr(2, [1999])), with_(corr(1.9, [])));
		expect(moved.chirpsFit!.changed).toBe(true);
		expect(moved.chirpsFit!.pooledFactor.delta).toBeCloseTo(-0.1, 12);
		expect(compareRuns(with_(corr(2, [1999])), with_(corr(2, []))).chirpsFit!.changed).toBe(true);
		// Only one side fitted any factors ('none', or no CHIRPS).
		expect(compareRuns(with_(corr(2, [], 'none')), with_(corr(2, []))).chirpsFit).toMatchObject({ excludedWaterYearsA: null, changed: true });
		expect(compareRuns(with_(null), with_(corr(2, [], 'none'))).chirpsFit).toBeNull();
	});

	it('notes a change of CHIRPS fit period, of a range’s factors or of a reference window (engine ≥ 0.29.0)', () => {
		const base = (): NonNullable<RunSummary['chirpsCorrection']> => ({
			mode: 'monthly', minDays: 90, minMm: 50, clampMin: 0.25, clampMax: 4,
			pooled: { days: 1000, catchmentMm: 2000, chirpsMm: 1000, ownFactor: 2, factor: 2, clamped: false },
			excludedWaterYears: [],
			months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, days: 100, catchmentMm: 200, chirpsMm: 100, ownFactor: 2, factor: 2, source: 'month' as const, clamped: false, fallbackDays: 0 })),
			fallbackDays: 0, correctedDays: 0, fallbackRawMm: 0, fallbackCorrectedMm: 0,
			fitPeriod: { period: 'all', ranges: [], segments: [] },
			fitWindow: { fromWaterYear: 1990, toWaterYear: 2009 }
		});
		const listed = (later: number, lastFitYear = 2009) => {
			const c = base();
			const seg = (from: number, f: number, fillFrom: number | null, fillTo: number | null, reason: string) => ({
				fromWaterYear: from, toWaterYear: from + 9, reason, fillFrom, fillTo,
				fitWindow: { fromWaterYear: from, toWaterYear: Math.min(from + 9, lastFitYear) },
				pooled: { ...c.pooled, ownFactor: f, factor: f },
				months: c.months.map((m) => ({ ...m, ownFactor: f, factor: f })),
				fallbackDays: 0, correctedDays: 0, fallbackRawMm: 0, fallbackCorrectedMm: 0
			});
			const ranges = [
				{ fromWaterYear: 1990, toWaterYear: 1999, reason: 'old network' },
				{ fromWaterYear: 2000, toWaterYear: 2009, reason: 'new network' }
			];
			c.fitPeriod = { period: 'ranges', ranges, segments: [seg(1990, 2.5, null, 1999, 'old network'), seg(2000, later, 2000, null, 'new network')] };
			c.fitWindow = { fromWaterYear: 1990, toWaterYear: lastFitYear };
			return c;
		};
		const with_ = (c: RunSummary['chirpsCorrection']) => run(summary([], { chirpsCorrection: c }));
		// Positive control: the same ranges, factors and windows are no change.
		expect(compareRuns(with_(listed(1.2)), with_(listed(1.2))).chirpsFit).toMatchObject({
			fitPeriodA: 'listed water years: 1990/91–1999/00 (old network); 2000/01–2009/10 (new network)',
			segmentsB: ['range 1990/91–1999/00 (old network)', 'range 2000/01–2009/10 (new network)'],
			fitWindowsB: ['all ranges: 1990/91–2009/10', 'range 1990/91–1999/00 (old network): 1990/91–1999/00', 'range 2000/01–2009/10 (new network): 2000/01–2009/10'],
			changed: false
		});
		// Whole record against ranges, with the whole-record factors equal: the period alone counts.
		expect(compareRuns(with_(base()), with_(listed(1.2))).chirpsFit).toMatchObject({ fitPeriodA: 'whole record', segmentsA: [], fitWindowsA: ['whole record: 1990/91–2009/10'], changed: true });
		// Same period, one range's factors moved.
		expect(compareRuns(with_(listed(1.2)), with_(listed(1.3))).chirpsFit!.changed).toBe(true);
		// Same period and factors, a different reference window (the later range lost its last years of data).
		expect(compareRuns(with_(listed(1.2)), with_(listed(1.2, 2007))).chirpsFit!.changed).toBe(true);
		// A run from before 0.29.0 has no windows: nothing to compare them with.
		const { fitWindow: _w, fitPeriod: _p, ...old } = base();
		expect(compareRuns(with_(old), with_(base())).chirpsFit).toMatchObject({ fitWindowsA: [], changed: false });
	});

	it('compares the runoff coefficient and KGE, e.g. legacy against GR4J', () => {
		const cal = { days: 3000, nse: 0.4, pbias: 12, rmseM3s: 0.5, meanObservedM3s: 1, meanSimulatedM3s: 1.1 };
		const catchment = summary([]).catchment;
		const legacy = run(summary([], { catchment: { ...catchment, runoffCoefficient: 1.8 }, calibration: { ...cal, kge: 0.3 } }));
		const gr4j = run(summary([], { catchment: { ...catchment, runoffCoefficient: 0.35 }, calibration: { ...cal, kge: 0.62 } }));
		const c = compareRuns(legacy, gr4j);
		expect(c.catchment.runoffCoefficient).toEqual({ a: 1.8, b: 0.35, delta: 0.35 - 1.8 });
		expect(c.calibration!.kge.delta).toBeCloseTo(0.32, 12);
		// Runs saved before either figure existed compare as missing, not as 0.
		expect(compareRuns(run(summary([], { calibration: cal })), gr4j).calibration!.kge).toEqual({ a: null, b: 0.62, delta: null });
	});

	it('compares the EWR agreement with the observed record, legacy against GR4J (issue #4)', () => {
		const catchment = summary([]).catchment;
		// Synthetic tables over the same 100 observed days; the river was below the EWR on 20.
		const legacyTable = ewrAgreement(
			[...new Array(60).fill(50), ...new Array(40).fill(200)],
			[...new Array(20).fill(50 / 86_400), ...new Array(80).fill(200 / 86_400)],
			new Array(100).fill(100),
			{ startDate: '2020-01-01' }
		);
		const gr4jTable = ewrAgreement(
			[...new Array(18).fill(50), ...new Array(82).fill(200)],
			[...new Array(20).fill(50 / 86_400), ...new Array(80).fill(200 / 86_400)],
			new Array(100).fill(100),
			{ startDate: '2020-01-01' }
		);
		const legacy = run(summary([], { catchment: { ...catchment, ewrAgreement: legacyTable } }));
		const gr4j = run(summary([], { catchment: { ...catchment, ewrAgreement: gr4jTable } }));
		const c = compareRuns(legacy, gr4j).ewrAgreement!;
		expect(c.frequencyBias).toEqual({ a: 3, b: 0.9, delta: 0.9 - 3 });
		expect(c.hitRate.a).toBe(1);
		expect(c.hitRate.b).toBeCloseTo(0.9, 12);
		expect(c.falseAlarmRatio.a).toBeCloseTo(40 / 60, 12);
		expect(c.falseAlarmRatio.b).toBe(0);
		expect(c.days).toEqual({ a: 100, b: 100, delta: 0 });
		// Older runs (no table), no observed record (null) or no observed day compare as missing.
		expect(compareRuns(run(summary([])), run(summary([]))).ewrAgreement).toBeNull();
		const none = run(summary([], { catchment: { ...catchment, ewrAgreement: null } }));
		expect(compareRuns(none, gr4j).ewrAgreement!.frequencyBias).toEqual({ a: null, b: 0.9, delta: null });
		const empty = ewrAgreement([1], [null], [1], { startDate: '2020-01-01' });
		expect(compareRuns(run(summary([], { catchment: { ...catchment, ewrAgreement: empty } })), none).ewrAgreement).toBeNull();
	});

	it('calibration is null when neither run has usable statistics, one-sided otherwise', () => {
		expect(compareRuns(run(summary([])), run(summary([]))).calibration).toBeNull();
		const empty = { days: 0, nse: null, pbias: null, rmseM3s: null, meanObservedM3s: null, meanSimulatedM3s: null };
		expect(compareRuns(run(summary([], { calibration: empty })), run(summary([]))).calibration).toBeNull();
		const one = compareRuns(run(summary([])), run(summary([], { calibration: { ...empty, days: 10, nse: 0.3 } })));
		expect(one.calibration!.nse).toEqual({ a: null, b: 0.3, delta: null });
		// Whether each side's scores are in-sample (issue #45); a run without it recorded is null.
		expect(one.calibration!.fitStatus).toEqual({ a: null, b: null });
		const fitted = compareRuns(run(summary([], { calibration: { ...empty, days: 10, nse: 0.5, fitStatus: 'fitted' } })), run(summary([], { calibration: { ...empty, days: 10, nse: 0.3, fitStatus: 'notFitted' } })));
		expect(fitted.calibration!.fitStatus).toEqual({ a: 'fitted', b: 'notFitted' });
		expect(one.samePeriod).toBe(true);
	});
});

describe('diffInputs', () => {
	it('reports nothing for identical inputs, including a copied project with fresh ids', () => {
		const s = snapshot();
		expect(diffInputs(s, structuredClone(s))).toEqual([]);
		expect(diffInputs(s, copyWithFreshIds(s))).toEqual([]);
	});

	it('does not flag settings stored sparsely vs merged over the defaults', () => {
		const a = snapshot({ settings: {} as RunInputsSnapshot['settings'] });
		// Except the runoff model: a run stored without one predates it and ran legacy.
		// Likewise the soil-water store: none stored means none used (engine < 0.14.0),
		// zero-rain runs: none stored means flagged runs ran as recorded (< 0.15.0),
		// and dam evaporation (engine < 0.16.0).
		const b = snapshot();
		(b.settings as Record<string, unknown>).runoffModel = 'legacy';
		b.settings.effectiveRainStoreMm = 0;
		b.settings.zeroRainRuns = { ...ACC, mode: 'asRecorded', keepDry: [], missing: [] };
		b.settings.lakeEvapFactor = 0;
		expect(diffInputs(a, b)).toEqual([]);
	});

	it('lists a change of the dam evaporation factor and of a dam\'s evaporation fields (N2)', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.settings.lakeEvapFactor = 0.6;
		const f = b.model.nodes.find((n) => n.name === 'Rooikloof')!;
		f.damAreaFullM2 = null;
		f.damSeepagePerDay = 0.002;
		expect(texts(a, b)).toEqual([
			'Rooikloof: dam area when full 0 m² → estimated (capacity ÷ 3 m)',
			'Rooikloof: dam seepage per day 0% → 0.2%',
			'Dam evaporation factor (× A-pan): 0.75 → 0.6'
		]);
	});

	it('lists a change of the annual assurance threshold (engine ≥ 0.32.0); absent is the default 0.9', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.settings.assuranceAnnualThreshold = 0.9;
		expect(texts(a, b)).toEqual([]);
		b.settings.assuranceAnnualThreshold = 0.8;
		expect(texts(a, b)).toEqual(['Annual assurance threshold: 90% → 80%']);
	});

	it('lists a change of GR4J\'s PE input (engine ≥ 0.31.0), and a run saved without one ran pan coefficient × A-pan', () => {
		const a = snapshot();
		const mm = [110, 130, 150, 160, 140, 115, 75, 45, 30, 30, 45, 75];
		const monthly = { kind: 'monthly' as const, mm: mm as never, source: 'farm AWS FAO-56 ET₀' };
		const b = structuredClone(a);
		b.settings.pe = monthly;
		expect(texts(a, b)).toEqual(['Potential evaporation (GR4J): pan coefficient × A-pan → monthly PE, 1\u202f105 mm/yr (source: farm AWS FAO-56 ET₀)']);
		expect(texts(b, a)).toEqual(['Potential evaporation (GR4J): monthly PE, 1\u202f105 mm/yr (source: farm AWS FAO-56 ET₀) → pan coefficient × A-pan']);
		// Positive control: the same PE is no change.
		expect(texts(b, structuredClone(b))).toEqual([]);
		// Two monthly rows: the months that changed and the annual totals.
		const c = structuredClone(b);
		(c.settings.pe as unknown as { mm: number[] }).mm[0] = 120;
		expect(texts(b, c)).toEqual(['Potential evaporation (GR4J): monthly PE Oct 110 → 120 mm (1\u202f105 → 1\u202f115 mm/yr)']);
		// A reworded source note is part of the record, so it is listed.
		const d = structuredClone(b);
		(d.settings.pe as { source: string }).source = 'SAWS station, 1991–2020';
		expect(texts(b, d)).toEqual(['Potential evaporation (GR4J): source "farm AWS FAO-56 ET₀" → "SAWS station, 1991–2020"']);
		// A snapshot saved before engine 0.31.0 has no pe: it ran pan × A-pan, so it matches today's default …
		const { pe: _pe, ...pre031 } = a.settings as Record<string, unknown>;
		const old = { ...a, settings: pre031 as RunInputsSnapshot['settings'] };
		expect(texts(old, a)).toEqual([]);
		// … and differs from a monthly PE.
		expect(texts(old, b)).toEqual(['Potential evaporation (GR4J): pan coefficient × A-pan → monthly PE, 1\u202f105 mm/yr (source: farm AWS FAO-56 ET₀)']);
		expect(peText({ ...monthly, source: '  ' })).toBe('monthly PE, 1\u202f105 mm/yr (no source given)');
	});

	it('lists an other water user added, and a change of its demand, return share and priority (WP-1.33)', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		const town = { ...node('u', 'Town', { kind: 'user', downstreamNodeId: 'copy-g', damCapacityM3: 0 }), userDemandM3Day: new Array(12).fill(1200), userReturnPct: 0.6, userPriority: 'senior' as const };
		b.model.nodes.push(town);
		expect(texts(a, b)).toEqual(['Other water user "Town" added (senior, demand 1\u202f200 m³/day on average over the months, drains into Outlet)']);
		const c = structuredClone(b);
		const t = c.model.nodes.find((n) => n.name === 'Town')!;
		t.userDemandM3Day![0] = 1500;
		t.userReturnPct = 0.5;
		t.userPriority = 'junior';
		expect(texts(b, c)).toEqual(['Town: share returned 60% → 50%', 'Town: priority senior → junior', 'Town: demand Oct 1\u202f200 → 1\u202f500 m³/day']);
		// A farm snapshot from before WP-1.33 (no user fields) diffs clean against one that has the defaults.
		const d = structuredClone(a);
		for (const n of d.model.nodes) Object.assign(n, { userDemandM3Day: null, userReturnPct: 0, userPriority: 'senior' });
		expect(texts(a, d)).toEqual([]);
	});

	it('lists a farm’s boreholes added and their depletion changed (WP-1.34)', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		const f = b.model.nodes.find((n) => n.name === 'Rooikloof')!;
		Object.assign(f, { boreholeCapacityM3Day: 500, boreholeRule: 'primary', streamDepletionFrac: 0.4, streamDepletionLagDays: 10 });
		expect(texts(a, b)).toEqual([
			'Rooikloof: borehole capacity none → 500 m³/day',
			'Rooikloof: borehole rule supplemental → primary',
			'Rooikloof: stream depletion share 0% → 40%',
			'Rooikloof: stream depletion lag 0 days → 10 days'
		]);
	});

	it('lists land cover added to, changed on and cleared from a farm, by farm and class (WP-1.35)', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		b.model.landCover = [{ id: 'l', nodeId: 'copy-f1', coverClass: 'invasive', areaKm2: 2, densityPct: 0.5, factors: null }];
		expect(texts(a, b)).toEqual(['Land cover "invasive" added to Rooikloof (1 km² condensed)']);
		const c = structuredClone(b);
		c.model.landCover![0]!.densityPct = 0.25;
		expect(texts(b, c)).toEqual(['Rooikloof: land cover "invasive" 1 km² → 0.5 km² condensed']);
		expect(texts(b, a)).toEqual(['Land cover "invasive" removed from Rooikloof (was 1 km² condensed)']);
	});

	it('lists a dam’s survey curve, release rule and seepage destination changed (WP-3.5)', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		const f = b.model.nodes.find((n) => n.name === 'Rooikloof')!;
		Object.assign(f, {
			damCurve: [
				{ levelM: 0, areaM2: 0, volumeM3: 0 },
				{ levelM: 4, areaM2: 5000, volumeM3: 12_000 }
			],
			damReleaseRule: 'fixed',
			damReleaseM3Day: [0, 0, 0, 50, 50, 0, 0, 0, 0, 0, 0, 0],
			damOutletCapacityM3Day: 400,
			damSeepageReturnPct: 0.5
		});
		b.settings = { ...b.settings, lakeEvapFactorMonthly: [0.75, 0.75, 0.75, 0.9, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75] as never };
		expect(texts(a, b)).toEqual([
			'Rooikloof: dam release rule none → fixed',
			'Rooikloof: dam outlet capacity no limit → 400 m³/day',
			'Rooikloof: share of dam seepage returning 100% → 50%',
			'Rooikloof: dam release none → 0, 0, 0, 50, 50, 0, 0, 0, 0, 0, 0, 0 m³/day (Oct–Sep)',
			'Rooikloof: dam survey curve none (power law) → 2 rows',
			'Monthly dam evaporation factors: the one factor → 0.75, 0.75, 0.75, 0.9, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75 (Oct–Sep)'
		]);
	});

	it('lists a farm’s supply rule and river pump changed, and not an older run’s absent fields (WP-3.8)', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		Object.assign(b.model.nodes.find((n) => n.name === 'Rooikloof')!, { supplyRule: 'trigger', pumpCapacityM3Day: 1200, supplyTriggerPct: 0.3, supplyStopPct: 0.7 });
		expect(texts(a, b)).toEqual([
			'Rooikloof: supply rule dam only → dam, river when low',
			'Rooikloof: river pump capacity no limit → 1\u202f200 m³/day',
			'Rooikloof: supply switch-to-river level 40% → 30%',
			'Rooikloof: supply switch-back level 60% → 70%'
		]);
		// A run from before engine 0.42.0 has none of the fields: it reads as the defaults, so no change.
		const c = copyWithFreshIds(a);
		for (const n of c.model.nodes) Object.assign(n, { supplyRule: 'damFirst', pumpCapacityM3Day: null, supplyTriggerPct: 0.4, supplyStopPct: 0.6 });
		expect(texts(a, c)).toEqual([]);
	});

	it('lists a farm’s hands-off flow and River to dam by month changed, and not an older run’s absent fields (engine 1.32.0)', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		const winter = [0, 0, 0, 0, 0, 0, 500, 500, 500, 500, 500, 500];
		Object.assign(b.model.nodes.find((n) => n.name === 'Rooikloof')!, { handsOffM3Day: new Array(12).fill(300), handsOffEwr: true, divertMonthlyM3Day: winter });
		expect(texts(a, b)).toEqual([
			'Rooikloof: hands-off keeps the EWR no → yes',
			'Rooikloof: hands-off flow none → 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300 m³/day (Oct–Sep)',
			'Rooikloof: River to dam by month the one diversion capacity → 0, 0, 0, 0, 0, 0, 500, 500, 500, 500, 500, 500 m³/day (Oct–Sep)'
		]);
		// A run from before engine 1.32.0 has none of the fields: it reads as the defaults, so no change.
		const c = copyWithFreshIds(a);
		for (const n of c.model.nodes) Object.assign(n, { handsOffM3Day: null, handsOffEwr: false, divertMonthlyM3Day: null });
		expect(texts(a, c)).toEqual([]);
	});

	it('lists individual boreholes added, changed and removed, matched across a copy by node and borehole name (WP-3.9)', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		const bh = { id: 'bh', nodeId: 'copy-f1', name: 'BH-01', capacityM3Day: 300, annualCapM3: 40_000, mode: 'primary' as const, emergencyBelowPct: 0.3, target: 'direct' as const, depletionFactor: 0.25 };
		b.model.boreholes = [bh];
		expect(texts(a, b)).toEqual(['Borehole "BH-01" added to Rooikloof (300 m³/day, primary, annual cap 40\u202f000 m³, depletion 0.25)']);
		// A copy with fresh ids still lines the borehole up by (node name, borehole name).
		const c = copyWithFreshIds(b);
		c.model.boreholes = [{ ...bh, id: 'bh-copy', nodeId: 'copy-copy-f1', annualCapM3: null, target: 'dam' }];
		expect(texts(b, c)).toEqual(['Rooikloof: borehole "BH-01" 300 m³/day, primary, annual cap 40\u202f000 m³, depletion 0.25 → 300 m³/day, primary into the dam, annual cap none, depletion 0.25']);
		expect(texts(b, a)).toEqual(['Borehole "BH-01" removed from Rooikloof (was 300 m³/day, primary, annual cap 40\u202f000 m³, depletion 0.25)']);
	});

	it('lists registered volumes added, changed and removed, and the allocation mode and band (engine 1.18.0)', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		const al = { id: 'al', nodeId: 'copy-f1', waterSource: 'surface' as const, volumeM3PerYear: 120_000, validFrom: '2020-10-01', validTo: null };
		b.model.allocations = [al];
		expect(texts(a, b)).toEqual(['Registered volume added to Rooikloof (surface 120\u202f000 m³/a, valid 2020-10-01 to …)']);
		// A copy with fresh ids lines it up by (unit name, water source).
		const c = copyWithFreshIds(b);
		c.model.allocations = [{ ...al, id: 'al-copy', nodeId: 'copy-copy-f1', volumeM3PerYear: 90_000 }];
		expect(texts(b, c)).toEqual(['Rooikloof: registered volume surface 120\u202f000 m³/a, valid 2020-10-01 to … → surface 90\u202f000 m³/a, valid 2020-10-01 to …']);
		expect(texts(b, a)).toEqual(['Registered volume removed from Rooikloof (was surface 120\u202f000 m³/a, valid 2020-10-01 to …)']);
		// A snapshot without the settings compared only at ±10 %: the same as saying so.
		const d = copyWithFreshIds(a);
		d.settings = { ...d.settings, allocationMode: 'none', allocationTolerance: 0.1 };
		expect(texts(a, d)).toEqual([]);
		d.settings = { ...d.settings, allocationMode: 'cap', allocationTolerance: 0.15 };
		expect(texts(a, d)).toEqual(['Allocation mode: Compare only → Cap use at the registered volume', 'Allocation comparison band: ±10% → ±15%']);
	});

	it('lists demand objects added, changed and removed, matched across a copy by unit and object name (engine 1.7.0)', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		const town = {
			id: 'do',
			nodeId: 'copy-f1',
			name: 'Town',
			category: 'municipal' as const,
			sizing: 'monthly' as const,
			monthlyM3Day: new Array(12).fill(600),
			count: null,
			litresPerUnitDay: null,
			lossPct: 0,
			monthlyFactor: null,
			returnPct: 0.5,
			priority: 'first' as const,
			destination: 'internal' as const,
			enabled: true,
			note: ''
		};
		b.model.demandObjects = [town];
		expect(texts(a, b)).toEqual(['Demand object "Town" added to Rooikloof (Municipal (town), 600 m³/day on average, return 0.5, priority first)']);
		const c = copyWithFreshIds(b);
		c.model.demandObjects = [{ ...town, id: 'do-copy', nodeId: 'copy-copy-f1', monthlyM3Day: [...town.monthlyM3Day.slice(0, 11), 0], destination: 'external', returnPct: 0 }];
		expect(texts(b, c)).toEqual([
			'Rooikloof: demand object "Town" Municipal (town), 600 m³/day on average, return 0.5, priority first → Municipal (town), 550 m³/day on average, piped out, priority first, monthly values changed'
		]);
		expect(texts(b, a)).toEqual(['Demand object "Town" removed from Rooikloof (was Municipal (town), 600 m³/day on average, return 0.5, priority first)']);
	});

	it('lists a demand object’s schedule change, and reads no schedule, null and an empty one alike (engine 1.17.0)', () => {
		const a = snapshot();
		const town = {
			id: 'do',
			nodeId: a.model.nodes.find((n) => n.name === 'Rooikloof')!.id,
			name: 'Town',
			category: 'municipal' as const,
			sizing: 'monthly' as const,
			monthlyM3Day: new Array(12).fill(600),
			count: null,
			litresPerUnitDay: null,
			lossPct: 0,
			monthlyFactor: null,
			returnPct: 0.5,
			priority: 'first' as const,
			destination: 'internal' as const,
			enabled: true,
			note: ''
		};
		a.model.demandObjects = [town];
		const b = structuredClone(a);
		b.model.demandObjects![0]!.schedule = [];
		expect(texts(a, b)).toEqual([]);
		// The same window with its keys in another order (as jsonb reads it back) is no change.
		a.model.demandObjects![0]!.schedule = [{ label: 'Weekends', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: [6, 7], factor: 0 }];
		const c = structuredClone(a);
		c.model.demandObjects![0]!.schedule = [{ factor: 0, to: null, span: 'always', from: null, label: 'Weekends', weekdays: [6, 7], easterTo: null, easterFrom: null }];
		expect(texts(a, c)).toEqual([]);
		delete a.model.demandObjects![0]!.schedule;
		b.model.demandObjects![0]!.schedule = [{ label: 'Weekends', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: [6, 7], factor: 0 }];
		expect(texts(a, b)).toEqual([
			'Rooikloof: demand object "Town" Municipal (town), 600 m³/day on average, return 0.5, priority first → Municipal (town), 600 m³/day on average, return 0.5, priority first, 1 schedule window, schedule changed'
		]);
	});

	it('lists a demand object’s people served, and reads none and null alike (engine 1.38.0)', () => {
		const a = snapshot();
		const town = {
			id: 'do',
			nodeId: a.model.nodes.find((n) => n.name === 'Rooikloof')!.id,
			name: 'Town',
			category: 'municipal' as const,
			sizing: 'monthly' as const,
			monthlyM3Day: new Array(12).fill(600),
			count: null,
			litresPerUnitDay: null,
			lossPct: 0,
			monthlyFactor: null,
			returnPct: 0.5,
			priority: 'first' as const,
			destination: 'internal' as const,
			enabled: true,
			note: ''
		};
		a.model.demandObjects = [town];
		const b = structuredClone(a);
		b.model.demandObjects![0]!.population = null;
		expect(texts(a, b)).toEqual([]);
		b.model.demandObjects![0]!.population = 12000;
		const [text, ...rest] = texts(a, b);
		expect(rest).toEqual([]);
		// fmtValue groups thousands with a narrow space.
		expect(text).toMatch(/^Rooikloof: demand object "Town" Municipal \(town\), 600 m³\/day on average, return 0\.5, priority first → Municipal \(town\), 600 m³\/day on average, return 0\.5, priority first, serves 12\D000 people$/);
	});

	it('describes a dam raise on a copied project by farm name', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		b.model.nodes.find((n) => n.name === 'Rooikloof')!.damCapacityM3 = 750_000;
		const d = diffInputs(a, b);
		expect(d).toEqual([
			{ area: 'network', kind: 'changed', subject: 'Rooikloof', text: 'Rooikloof: dam capacity 600\u202f000 m³ → 750\u202f000 m³' }
		]);
	});

	it('describes node percentages, additions, removals, renames and re-routing', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.model.nodes[1]!.irrigationEfficiency = 0.85;
		b.model.nodes[2]!.name = 'Bergwater Suid'; // same id → rename
		b.model.nodes[2]!.downstreamNodeId = 'f1';
		b.model.nodes.push(node('f3', 'Klipfontein', { damCapacityM3: 0 }));
		const c = structuredClone(a);
		c.model.nodes = c.model.nodes.filter((n) => n.id !== 'f2');
		expect(texts(a, b)).toEqual([
			'Farm "Klipfontein" added (10 km², drains into Outlet)',
			'Rooikloof: irrigation efficiency 80% → 85%',
			'Bergwater Suid: renamed from "Bergwater"',
			'Bergwater Suid: drains into Rooikloof (was Outlet)'
		]);
		expect(texts(a, c)).toEqual(['Farm "Bergwater" removed']);
	});

	it('reads a run saved before engine 0.16.0 as migration 006 stored it: return flow % → efficiency (N1)', () => {
		const old = snapshot();
		for (const n of old.model.nodes as unknown as Record<string, unknown>[]) {
			delete n.irrigationEfficiency;
			delete n.lossReturnFraction;
			n.returnFlowPct = n.kind === 'farm' ? 0.1 : 0;
		}
		// r = 0.1 became e = 0.9 with every loss returning: the same model, no line.
		const migrated = snapshot();
		for (const n of migrated.model.nodes) Object.assign(n, n.kind === 'farm' ? { irrigationEfficiency: 0.9, lossReturnFraction: 1 } : { irrigationEfficiency: 1, lossReturnFraction: 0 });
		expect(texts(old, migrated)).toEqual([]);
		// A real change since then is reported against the migrated values.
		migrated.model.nodes[1]!.irrigationEfficiency = 0.8;
		expect(texts(old, migrated)).toEqual(['Rooikloof: irrigation efficiency 90% → 80%']);
	});

	it('describes crops and crop areas in hectares', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		b.model.crops.push({ id: 'apples', name: 'Apples', cropFactor: new Array(12).fill(0.8) });
		b.model.cropAreas.push({ nodeId: 'copy-f2', cropId: 'apples', areaM2: 400_000 });
		b.model.cropAreas[0]!.areaM2 = 250_000;
		b.model.crops[0]!.cropFactor[0] = 0.75;
		expect(texts(a, b)).toEqual([
			'Crop "Apples" added',
			'Crop "Citrus" crop factor: Oct 0.7 → 0.75',
			'Rooikloof: "Citrus" area 20 ha → 25 ha',
			'Crop "Apples" added to Bergwater (40 ha)'
		]);
		const c = structuredClone(a);
		c.model.cropAreas = [];
		expect(texts(a, c)).toEqual(['Crop "Citrus" removed from Rooikloof (was 20 ha)']);
	});

	it('describes a crop’s own irrigation efficiency and the monthly effective-rain fraction (engine 0.43.0)', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.model.crops[0]!.irrigationEfficiency = 0.9;
		b.settings = { ...b.settings, effectiveRainFractionMonthly: [0.5, 0.5, 0.6, 0.7, 0.7, 0.6, 0.5, 0.4, 0.3, 0.3, 0.4, 0.5] as never };
		expect(texts(a, b)).toEqual([
			'Crop "Citrus" irrigation efficiency: the farm\'s → 90%',
			'Monthly effective rain fractions: the one fraction → 0.5, 0.5, 0.6, 0.7, 0.7, 0.6, 0.5, 0.4, 0.3, 0.3, 0.4, 0.5 (Oct–Sep)'
		]);
		// null is the same as never set: no change reported.
		const c = structuredClone(a);
		c.model.crops[0]!.irrigationEfficiency = null;
		c.settings = { ...c.settings, effectiveRainFractionMonthly: null };
		expect(texts(a, c)).toEqual([]);
	});

	it('follows a crop area through a farm rename in the same project', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.model.nodes[1]!.name = 'Rooikloof Oos';
		expect(texts(a, b)).toEqual(['Rooikloof Oos: renamed from "Rooikloof"']);
	});

	it('describes transfers matched by route across a copy', () => {
		const t = { id: 't1', fromNodeId: 'f1', toNodeId: 'f2', months: [10, 11, 12, 1, 2, 3], maxRateM3s: 0.05, dailyCapM3: null, minStoragePct: 0.2, enabled: true, priority: 0 };
		const a = snapshot();
		const b = copyWithFreshIds(snapshot({ model: { ...a.model, transfers: [t] } }));
		expect(texts(a, b)).toEqual(['Transfer Rooikloof → Bergwater added (0.05 m³/s, Oct–Mar)']);
		const a2 = snapshot({ model: { ...a.model, transfers: [t] } });
		const b2 = copyWithFreshIds(a2);
		Object.assign(b2.model.transfers[0]!, { enabled: false, months: [12, 1], maxRateM3s: 0.08, dailyCapM3: 4000, minStoragePct: 0.3 });
		expect(texts(a2, b2)).toEqual([
			'Transfer Rooikloof → Bergwater: disabled',
			'Transfer Rooikloof → Bergwater: months Oct–Mar → Dec, Jan',
			'Transfer Rooikloof → Bergwater: max rate 0.05 → 0.08 m³/s',
			'Transfer Rooikloof → Bergwater: daily cap none → 4\u202f000 m³',
			'Transfer Rooikloof → Bergwater: minimum source storage 20% → 30%'
		]);
		expect(texts(a2, a)).toEqual(['Transfer Rooikloof → Bergwater removed']);
	});

	it('describes a transfer\'s monthly rates month by month (engine 1.14.0), and a rule written as its one rate per month as no change', () => {
		const t = { id: 't1', fromNodeId: 'f1', toNodeId: 'f2', months: [12, 1], maxRateM3s: 0.05, dailyCapM3: null, minStoragePct: 0.2, enabled: true, priority: 0 };
		const a = snapshot();
		const a2 = snapshot({ model: { ...a.model, transfers: [t] } });
		// The same rule written as monthly rates: nothing a run would do differently.
		const same = structuredClone(a2);
		Object.assign(same.model.transfers[0]!, withMonthlyRates([0, 0, 0.05, 0.05, 0, 0, 0, 0, 0, 0, 0, 0]));
		expect(texts(a2, same)).toEqual([]);
		const b = structuredClone(a2);
		Object.assign(b.model.transfers[0]!, withMonthlyRates([0, 0.01, 0.05, 0.02, 0, 0, 0, 0, 0, 0, 0, 0]));
		expect(texts(a2, b)).toEqual(['Transfer Rooikloof → Bergwater: max rate by month Nov 0 → 0.01, Jan 0.05 → 0.02 m³/s (0 = off)']);
	});

	it('describes a river off-take and its fields (engine 1.14.0); a dam transfer written with the defaults is no change', () => {
		const t = { id: 't1', fromNodeId: 'f1', toNodeId: 'f2', months: [12, 1], maxRateM3s: 0.05, dailyCapM3: null, minStoragePct: 0.2, enabled: true, priority: 0 };
		const a = snapshot();
		const a2 = snapshot({ model: { ...a.model, transfers: [t] } });
		const same = structuredClone(a2);
		Object.assign(same.model.transfers[0]!, { source: 'dam', handsOffM3Day: null, handsOffEwr: false, lossPct: 0, sizing: 'demand', topUpDam: false });
		expect(texts(a2, same)).toEqual([]);
		const b = structuredClone(a2);
		Object.assign(b.model.transfers[0]!, { source: 'river', handsOffM3Day: 500, handsOffEwr: true, lossPct: 0.1, sizing: 'capacity', topUpDam: true });
		expect(texts(a2, b)).toEqual([
			'Transfer Rooikloof → Bergwater: takes from the source dam → the river (an off-take)',
			'Transfer Rooikloof → Bergwater: hands-off flow none → 500 m³/day',
			'Transfer Rooikloof → Bergwater: now leaves the EWR in the river',
			'Transfer Rooikloof → Bergwater: conveyance losses 0% → 10%',
			"Transfer Rooikloof → Bergwater: sized to the destination's need → up to capacity",
			"Transfer Rooikloof → Bergwater: now tops up the destination's dam"
		]);
		const c = snapshot({ model: { ...a.model, transfers: [] } });
		expect(texts(c, b)).toEqual(['Transfer Rooikloof → Bergwater added (a river off-take, 0.05 m³/s, Dec, Jan)']);
	});

	it('describes settings: scalars, calibration, monthly tables and unknown keys', () => {
		// Two legacy runs, so the legacy model's own calibration settings count too.
		const a = legacySnapshot();
		const b = structuredClone(a);
		const ca = a.settings.calibration as unknown as Record<string, number[]>;
		const cb = b.settings.calibration as unknown as Record<string, unknown>;
		cb.a = 0.11;
		cb.summerMonths = [11, 12, 1, 2];
		cb.recessionFactors = [...ca.recessionFactors!.slice(0, 79), 0.99];
		b.settings.effectiveRainFraction = 0.7;
		b.settings.simulationStart = '2005-10-01';
		(b.settings as Record<string, unknown>).ewrPragmaticM3PerDay = [100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		(b.settings as Record<string, unknown>).apanMm = new Array(12).fill(150);
		b.settings.hiLoSplit = { hi: 0.7, lo: 0.3 };
		(b.settings as Record<string, unknown>).futureKnob = 3;
		expect(texts(a, b)).toEqual([
			'Effective rain fraction: 0.65 → 0.7',
			'Simulation start: first day with rain → 2005-10-01',
			'A-pan evaporation: changed in 12 months',
			'Pragmatic EWR: Oct 0 → 100 m³/day',
			'Hi/lo MAP split: 0.5/0.5 → 0.7/0.3',
			'Calibration peak flow coefficient a: 0.1 → 0.11',
			'Calibration summer months: Oct–Feb → Nov–Feb',
			'Calibration recession factors: 1 value changed',
			'Setting "futureKnob" changed'
		]);
		expect(diffInputs(a, b).every((c) => c.area === 'settings' && c.kind === 'changed')).toBe(true);
	});

	it('names the soil-water store size, and reads a snapshot from before it as no store (0 mm)', () => {
		const a = snapshot();
		(a.settings as Record<string, unknown>).effectiveRainStoreMm = 25;
		const b = structuredClone(a);
		(b.settings as Record<string, unknown>).effectiveRainStoreMm = 10;
		expect(texts(a, b)).toEqual(['Soil-water store (effective rain carry-over): 25 mm → 10 mm']);
		// Runs store merged settings, so no size means engine < 0.14.0, which carried nothing over.
		const old = snapshot();
		delete (old.settings as Record<string, unknown>).effectiveRainStoreMm;
		expect(texts(old, a)).toEqual(['Soil-water store (effective rain carry-over): 0 mm → 25 mm']);
		const none = structuredClone(a);
		(none.settings as Record<string, unknown>).effectiveRainStoreMm = 0;
		expect(diffInputs(old, none)).toEqual([]);
	});

	it('describes calibration exclusions added, removed and re-reasoned', () => {
		const a = snapshot();
		a.settings.calibrationExclusions = [
			{ waterYear: 2015, reason: 'suspect rain' },
			{ start: '2017-01-01', end: '2017-02-01', reason: 'gauge outage' }
		];
		const b = structuredClone(a);
		b.settings.calibrationExclusions = [
			{ waterYear: 2015, reason: 'rain gauge moved' },
			{ waterYear: 2018, reason: 'after the flood broke the weir' }
		];
		expect(diffInputs(a, b)).toEqual([
			{
				area: 'settings',
				kind: 'removed',
				subject: 'Calibration exclusion 2017-01-01 – 2017-02-01',
				text: 'Calibration exclusion 2017-01-01 – 2017-02-01 removed (was: “gauge outage”)'
			},
			{
				area: 'settings',
				kind: 'changed',
				subject: 'Calibration exclusion WY 2015/16',
				text: 'Calibration exclusion WY 2015/16: reason “suspect rain” → “rain gauge moved”'
			},
			{
				area: 'settings',
				kind: 'added',
				subject: 'Calibration exclusion WY 2018/19',
				text: 'Calibration exclusion WY 2018/19 added: “after the flood broke the weir”'
			}
		]);
		// Runs saved before exclusions existed compare as none.
		const old = snapshot();
		delete (old.settings as Record<string, unknown>).calibrationExclusions;
		expect(diffInputs(old, snapshot())).toEqual([]);
	});

	it('describes the zero-rain run settings (CR-20); a run saved before them ran flagged runs as recorded', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.settings.zeroRainRuns = {
			...defaultProjectSettings().zeroRainRuns,
			mode: 'asRecorded',
			keepDry: [{ start: '2003-05-01', end: '2003-08-31', reason: 'real drought' }],
			missing: [{ waterYear: 1999, reason: 'gauge offline' }]
		};
		expect(texts(a, b)).toEqual([
			'Flagged zero-rain runs: treated as missing (CHIRPS fills them) → run as recorded (dry)',
			'Keep-dry period 2003-05-01 – 2003-08-31 added: “real drought”',
			'Missing-rain period WY 1999/00 added: “gauge offline”'
		]);
		const old = snapshot();
		delete (old.settings as Record<string, unknown>).zeroRainRuns;
		expect(texts(old, a)).toEqual([
			'Flagged zero-rain runs: run as recorded (dry) → treated as missing (CHIRPS fills them)',
			'Multi-day rain accumulations: run as recorded (one day) → spread over the days they cover (CHIRPS pattern)'
		]);
		const recorded = structuredClone(a);
		recorded.settings.zeroRainRuns = { ...ACC, mode: 'asRecorded', keepDry: [], missing: [] };
		expect(diffInputs(old, recorded)).toEqual([]);
	});

	it('describes the quality-flag settings (CR-18/19); a run saved before engine 1.22.0 reads as the defaults', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.settings.qualityFlags = {
			...defaultProjectSettings().qualityFlags,
			suspect: 'include',
			ratings: { flow_observed_m3s: { gaugedMaxM3s: 12, gaugedMinM3s: null, source: 'DWS gaugings' } }
		};
		expect(texts(a, b)).toEqual(['Gauged range (gauge record): none → up to 12 m³/s', 'Suspect days in the fit: left out → scored as recorded']);
		const old = snapshot();
		delete (old.settings as Record<string, unknown>).qualityFlags;
		expect(diffInputs(old, a)).toEqual([]);
	});

	it('describes a calibration rule change and a sign-off (issue #153); a run saved before engine 1.25.0 reads as the default rules', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.settings.calibrationRules = {
			...defaultProjectSettings().calibrationRules,
			revision: 2,
			selection: { test: 'split', score: 'kgePrime' },
			signedOff: { by: 'A. Hydrologist', on: '2026-09-29' }
		};
		expect(texts(a, b)).toEqual([
			'Calibration rules, keep: the best KGE′ (Kling–Gupta, 2012) on the dry → wet test (wet years) → the best KGE′ (Kling–Gupta, 2012) on the split-sample test (other half)',
			'Calibration rules: draft (not signed off) → signed off by A. Hydrologist on 2026-09-29'
		]);
		const old = snapshot();
		delete (old.settings as Record<string, unknown>).calibrationRules;
		expect(diffInputs(old, a)).toEqual([]);
	});

	it('describes the multi-day accumulation settings (B4); a run saved before 0.20.0 ran them as recorded', () => {
		const a = snapshot();
		const b = structuredClone(a);
		const z0 = defaultProjectSettings().zeroRainRuns;
		b.settings.zeroRainRuns = {
			...z0,
			accumulationMode: 'asRecorded',
			keepReadings: [{ start: '2003-06-10', end: '2003-06-10', reason: 'thunderstorm' }],
			addAccumulations: [{ start: '2003-07-01', end: '2003-07-09', reason: 'observer away' }]
		};
		expect(texts(a, b)).toEqual([
			'Multi-day rain accumulations: spread over the days they cover (CHIRPS pattern) → run as recorded (one day)',
			'Keep-reading period 2003-06-10 – 2003-06-10 added: “thunderstorm”',
			'Listed accumulation 2003-07-01 – 2003-07-09 added: “observer away”'
		]);
		// A 0.15–0.19 run stored zeroRainRuns without the accumulation fields: it compares as "as recorded".
		const old = snapshot();
		const { accumulationMode: _m, keepReadings: _k, addAccumulations: _a, ...pre } = z0;
		(old.settings as Record<string, unknown>).zeroRainRuns = pre;
		const recorded = structuredClone(a);
		recorded.settings.zeroRainRuns = { ...z0, accumulationMode: 'asRecorded' };
		expect(diffInputs(old, recorded)).toEqual([]);
	});

	it('describes the fit record: set, replaced, edited since, and removed', () => {
		const rec = { fittedAt: '2026-09-24T10:05:33.120Z', model: 'gr4j', objective: 'kgePrime', seed: 7, editedParams: [] as string[] };
		const a = snapshot();
		const b = structuredClone(a);
		(b.settings as Record<string, unknown>).fitRecord = rec;
		expect(texts(a, b)).toEqual(['Parameters now from a GR4J fit of 2026-09-24 10:05 UTC (KGE′, seed 7)']);
		expect(texts(b, a)).toEqual(['Fit record removed (was a GR4J fit of 2026-09-24 10:05 UTC (KGE′, seed 7))']);
		const edited = structuredClone(b);
		(edited.settings as Record<string, unknown>).fitRecord = { ...rec, editedParams: ['x1'] };
		expect(texts(b, edited)).toEqual(['Fit record: parameters edited since the fit (x1)']);
		expect(texts(edited, b)).toEqual(['Fit record: parameters back to the fitted values (were edited: x1)']);
		const refit = structuredClone(b);
		(refit.settings as Record<string, unknown>).fitRecord = { ...rec, seed: 8, fittedAt: '2026-09-25T08:00:00Z' };
		expect(texts(b, refit)).toEqual([
			'Fit record: GR4J fit of 2026-09-24 10:05 UTC (KGE′, seed 7) → GR4J fit of 2026-09-25 08:00 UTC (KGE′, seed 8)'
		]);
		expect(diffInputs(b, structuredClone(b))).toEqual([]);
	});

	it('a GR4J run saved before engine 1.0.0 (with the legacy calibration keys stored) compares clean against one after', () => {
		const before = legacySnapshot();
		before.settings.runoffModel = 'gr4j';
		const after = snapshot();
		expect(Object.keys(after.settings.calibration!).sort()).toEqual(['catchmentAreaKm2', 'rainThresholdMm']);
		expect(diffInputs(before, after)).toEqual([]);
		// Positive control: a setting both kept still shows.
		(after.settings.calibration as unknown as Record<string, unknown>).rainThresholdMm = 3;
		expect(texts(before, after)).toEqual(['Calibration rain threshold: 2 mm → 3 mm']);
	});

	it('describes a switch of runoff model and GR4J parameter changes', () => {
		// A legacy run (engine < 1.0.0) against a GR4J one: the model line says it, and the
		// legacy model's own settings, which never touched the GR4J run, are not listed.
		const a = legacySnapshot();
		const b = structuredClone(a);
		b.settings.runoffModel = 'gr4j';
		b.settings.calibration = snapshot().settings.calibration;
		b.settings.gr4j = { x1: 420, x2: 0, x3: 90, x4: 2.1, warmupDays: 365 };
		(b.settings as Record<string, unknown>).panCoefficient = [0.8, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7];
		expect(texts(a, b)).toEqual([
			'Runoff model: legacy (b023 recession) → GR4J',
			'Pan coefficient: Oct 0.7 → 0.8',
			'GR4J production store X1: 350 mm → 420 mm',
			'GR4J unit hydrograph time base X4: 1.7 days → 2.1 days'
		]);
		// Runs saved before these settings existed compare as what they ran:
		// legacy (not today's GR4J default) and the default GR4J parameters.
		const old = structuredClone(a);
		delete (old.settings as Record<string, unknown>).gr4j;
		delete (old.settings as Record<string, unknown>).runoffModel;
		expect(diffInputs(old, a)).toEqual([]);
		expect(texts(old, { ...a, settings: { ...a.settings, runoffModel: 'gr4j' } })).toEqual(['Runoff model: legacy (b023 recession) → GR4J']);
		// Provenance only, but a changed note is still a difference between the two runs' records (engine ≥ 0.31.1).
		expect(texts(a, { ...a, settings: { ...a.settings, panCoefficientSource: 'FAO-56 Table 5' } })).toEqual(['Pan coefficient source: none → "FAO-56 Table 5"']);
	});

	it('describes a change of the CHIRPS bias correction', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.settings.chirpsBiasCorrection = 'none';
		expect(texts(a, b)).toEqual(['CHIRPS bias correction: monthly factors → raw CHIRPS']);
		// A run saved before the setting existed compares as the default.
		const old = structuredClone(a);
		delete (old.settings as Record<string, unknown>).chirpsBiasCorrection;
		expect(diffInputs(old, a)).toEqual([]);
	});

	it('describes a change of the CHIRPS fit period (engine ≥ 0.29.0)', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.settings.chirpsFitPeriod = [{ fromWaterYear: 2005, toWaterYear: 2019, reason: 'new network' }];
		expect(texts(a, b)).toEqual(['CHIRPS fit period: whole record → listed water years: 2005/06–2019/20 (new network)']);
		// A run saved before the setting existed fitted the whole record, the default.
		const old = structuredClone(a);
		delete (old.settings as Record<string, unknown>).chirpsFitPeriod;
		expect(diffInputs(old, a)).toEqual([]);
	});

	it('describes series added, removed, extended and trimmed', () => {
		const a = snapshot({
			series: {
				rain_catchment_mm: { startDate: '2000-01-01', length: 366 },
				flow_observed_m3s: { startDate: '2000-01-01', length: 10 }
			}
		});
		const b = snapshot({
			series: {
				rain_catchment_mm: { startDate: '1999-12-31', length: 368 },
				flow_logger_m3s: { startDate: '2000-01-01', length: 31 }
			}
		});
		expect(texts(a, b)).toEqual([
			'Logger flow series added (2000-01-01 to 2000-01-31)',
			'Observed flow series removed',
			'Rainfall (catchment) series extended to 2001-01-01 (was 2000-12-31)',
			'Rainfall (catchment) series extended back to 1999-12-31 (was 2000-01-01)',
			// Snapshots without stored values: the shared days can't be checked, and it says so.
			'Rainfall (catchment): the days both runs cover were not checked for edits (a run from before runs stored their input series)'
		]);
		const c = snapshot({ series: { rain_catchment_mm: { startDate: '2000-02-01', length: 30 } } });
		expect(texts(a, c)).toContain('Rainfall (catchment) series now ends 2000-03-01 (was 2000-12-31)');
		expect(texts(a, c)).toContain('Rainfall (catchment) series now starts 2000-02-01 (was 2000-01-01)');
	});

	it('labels the report and calibration windows, the calibration series and data-quality thresholds', () => {
		const a = snapshot();
		const b = structuredClone(a);
		Object.assign(b.settings, {
			reportStart: '2015-10-01',
			calibrationEnd: '2012-09-30',
			calibrationFlowKind: 'flow_logger_m3s',
			dataQuality: { agreementMinRatio: 0.8 } // stored sparsely: the other two stay at their defaults
		});
		expect(texts(a, b)).toEqual([
			'Curtailment report start: start of run → 2015-10-01',
			'Calibration window end: end of record → 2012-09-30',
			'Calibration flow series: default (observed, else logger) → Logger flow',
			'Data quality gauge/logger lowest ratio: 66.67% → 80%'
		]);
		// A run stored before dataQuality existed compares equal to one with the defaults.
		const old = structuredClone(a);
		delete (old.settings as Record<string, unknown>).dataQuality;
		expect(texts(old, a)).toEqual([]);
		// One stored before the other limits were settings (engine < 1.20.0) ran their defaults.
		const pre120 = structuredClone(a);
		(pre120.settings as Record<string, unknown>).dataQuality = { agreementMinRatio: 2 / 3, agreementMaxRatio: 1.5, agreementMinDays: 90 };
		expect(texts(pre120, a)).toEqual([]);
		const c = structuredClone(a);
		Object.assign(c.settings, { dataQuality: { zeroRunRule: 'usualRain', zeroRunChirpsCheck: true, lowVsChirpsBaseline: 'moving', outlierFactorFlow: 20 } });
		expect(texts(a, c)).toEqual([
			'Data quality flow outlier factor: 10× the 99th percentile → 20× the 99th percentile',
			'Data quality zero-rain run rule: days in the wet season → share of the usual annual rain',
			'Data quality zero-rain run CHIRPS check: off → on',
			'Data quality low vs CHIRPS usual ratio: whole-record median → moving median (±5 years)'
		]);
	});

	it('treats month lists as sets: order and repeats are not a change', () => {
		const a = snapshot();
		a.model.transfers = [{ id: 't', fromNodeId: 'f1', toNodeId: 'f2', months: [10, 2, 1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0.3, enabled: true, priority: 0 }];
		(a.settings as Record<string, unknown>).runoffModel = 'legacy';
		(a.settings.calibration as unknown as Record<string, unknown>).summerMonths = [12, 1, 11];
		const b = structuredClone(a);
		b.model.transfers[0]!.months = [1, 2, 10, 10];
		(b.settings.calibration as unknown as Record<string, unknown>).summerMonths = [1, 11, 12];
		expect(texts(a, b)).toEqual([]);
		b.model.transfers[0]!.months = [1, 2];
		expect(texts(a, b)).toEqual(['Transfer Rooikloof → Bergwater: months Oct, Jan, Feb → Jan, Feb']);
	});

	it('says when a series became empty or got values, instead of inventing a one-day range', () => {
		const withRain = (length: number) => snapshot({ series: { rain_catchment_mm: { startDate: '2000-01-01', length } } });
		expect(texts(withRain(366), withRain(0))).toEqual(['Rainfall (catchment) series now has no values (was 2000-01-01 to 2000-12-31)']);
		expect(texts(withRain(0), withRain(31))).toEqual(['Rainfall (catchment) series now has values (2000-01-01 to 2000-01-31)']);
		expect(texts(withRain(0), withRain(0))).toEqual([]);
		expect(texts(snapshot({ series: {} }), withRain(0))).toEqual(['Rainfall (catchment) series added (no values)']);
	});

	it('describes series dates across a leap day the same in any time zone', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const a = snapshot({ series: { rain_catchment_mm: { startDate: '2020-02-28', length: 1 } } });
		const b = snapshot({ series: { rain_catchment_mm: { startDate: '2020-02-28', length: 3 } } });
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
				env.TZ = zone;
				expect(texts(a, b), zone).toEqual(['Rainfall (catchment) series extended to 2020-03-01 (was 2020-02-28)', 'Rainfall (catchment): the days both runs cover were not checked for edits (a run from before runs stored their input series)']);
			}
		} finally {
			env.TZ = tz;
		}
	});

	it('reports values changed within the same dates from the series hash', () => {
		const s = (valuesSha256?: string) =>
			snapshot({ series: { rain_catchment_mm: { startDate: '2000-01-01', length: 366, ...(valuesSha256 ? { valuesSha256 } : {}) } } });
		expect(texts(s('aa'), s('bb'))).toEqual(['Rainfall (catchment) values changed (same dates, 2000-01-01 to 2000-12-31)']);
		expect(diffInputs(s('aa'), s('bb'))[0]).toMatchObject({ area: 'series', kind: 'changed', subject: 'Rainfall (catchment)' });
		expect(texts(s('aa'), s('aa'))).toEqual([]);
		// Runs stored before hashes existed: nothing to compare, nothing reported.
		expect(texts(s(), s('bb'))).toEqual([]);
		// Different dates and no stored values: the hash can't isolate the shared days, and the diff says so.
		const longer = snapshot({ series: { rain_catchment_mm: { startDate: '2000-01-01', length: 367, valuesSha256: 'cc' } } });
		expect(texts(s('aa'), longer)).toEqual(['Rainfall (catchment) series extended to 2001-01-01 (was 2000-12-31)', 'Rainfall (catchment): the days both runs cover were not checked for edits (a run from before runs stored their input series)']);
	});

	it('notes a CHIRPS version change (issue #40 part c), only when both runs recorded the version', () => {
		const s = (provenance?: { product: string; version: string } | null) =>
			snapshot({
				series: { rain_chirps_mm: { startDate: '2000-01-01', length: 366, valuesSha256: 'aa', ...(provenance !== undefined ? { provenance } : {}) } }
			});
		const v2 = { product: 'CHIRPS', version: '2.0' };
		const v3 = { product: 'CHIRPS', version: '3.0' };
		expect(texts(s(v2), s(v3))).toEqual([
			'Rainfall (CHIRPS) is now CHIRPS v3.0 (was CHIRPS v2.0): the monthly CHIRPS factors are fitted on the new values, and a calibration made on the old ones no longer holds'
		]);
		expect(texts(s(null), s(v3))).toEqual([
			'Rainfall (CHIRPS) is now CHIRPS v3.0 (was an unrecorded version): the monthly CHIRPS factors are fitted on the new values, and a calibration made on the old ones no longer holds'
		]);
		expect(texts(s(v2), s({ ...v2 }))).toEqual([]);
		// A run from before the version was recorded: nothing to compare.
		expect(texts(s(), s(v3))).toEqual([]);
		// Another kind gets the line without the CHIRPS factors' note.
		const rain = (provenance: { product: string; version: string } | null) =>
			snapshot({ series: { rain_catchment_mm: { startDate: '2000-01-01', length: 366, valuesSha256: 'aa', provenance } } });
		expect(texts(rain(null), rain(v3))).toEqual(['Rainfall (catchment) is now CHIRPS v3.0 (was an unrecorded version)']);
	});

	it('notes a change of a series’ source or given unit (issue #66), only when both runs recorded it', () => {
		const s = (origin?: { source: string | null; unit: string | null; factor: number | null } | null) =>
			snapshot({ series: { flow_observed_m3s: { startDate: '2000-01-01', length: 366, valuesSha256: 'aa', ...(origin !== undefined ? { origin } : {}) } } });
		const dws = { source: 'DWS X1H001', unit: 'm³/s', factor: 1 };
		expect(texts(s(dws), s({ ...dws, unit: 'l/s', factor: 0.001 }))).toEqual([
			'Observed flow now comes from DWS X1H001 · given in l/s (× 0.001) (was DWS X1H001 · given in m³/s)'
		]);
		expect(texts(s(null), s(dws))).toEqual(['Observed flow now comes from DWS X1H001 · given in m³/s (was source not recorded)']);
		expect(texts(s(dws), s({ ...dws }))).toEqual([]);
		// A run from before the source was recorded: nothing to compare.
		expect(texts(s(), s(dws))).toEqual([]);
	});

	it('notes a change of the flow gap filling, and nothing between a run from before it and one with it off (issue #66)', () => {
		const spec = { interpolateMaxDays: 5, donor: 'flow_logger_m3s', donorMaxDays: 60, donorMinOverlapDays: 365 };
		const fill = (f: unknown) => snapshot({ settings: { ...snapshot().settings, flowGapFill: f } as never });
		const off = { flow_observed_m3s: null, flow_logger_m3s: null };
		expect(texts(snapshot(), fill(off))).toEqual([]);
		expect(texts(fill(off), fill({ ...off, flow_observed_m3s: spec }))).toEqual([
			'Gap filling of the observed gauge flow: not filled → interpolate gaps up to 5 days, fill gaps up to 60 days from the logger flow (365 shared days at least)'
		]);
	});

	it('notes a declared uncertainty rule set, changed or withdrawn, and nothing between absent and null (issue #71)', () => {
		const rule = { members: 300, bounds: 'typical', panOffset: 0.1, thresholds: { objective: 'kgePrime', minSkill: 0.5, wr2012MaxLevel: 'query', maxLowFlowBiasPct: 50 } };
		const text = 'skill score KGE′, lowest skill kept 0.5, worst wr2012 flag kept query, largest low-flow bias kept ±50 %, members 300, bounds typical, pan coefficient shift ±0.1';
		const withRule = (r: unknown) => snapshot({ settings: { ...snapshot().settings, evidenceUncertaintyRule: r } as never });
		const absent = snapshot();
		expect('evidenceUncertaintyRule' in absent.settings).toBe(false);
		// Positive control for the "no line" cases below: absent → a rule is seen.
		expect(texts(absent, withRule(rule))).toEqual([`Declared uncertainty rule (evidence): not declared → ${text}`]);
		expect(texts(withRule(null), withRule(rule))).toEqual([`Declared uncertainty rule (evidence): not declared → ${text}`]);
		expect(texts(withRule(rule), withRule(null))).toEqual([`Declared uncertainty rule (evidence): ${text} → not declared`]);
		expect(texts(withRule(rule), withRule({ ...rule, members: 500 }))).toEqual([
			`Declared uncertainty rule (evidence): ${text} → ${text.replace('members 300', 'members 500')}`
		]);
		expect(texts(absent, withRule(null))).toEqual([]);
		expect(texts(withRule(null), absent)).toEqual([]);
		expect(texts(withRule(rule), withRule({ ...rule, thresholds: { ...rule.thresholds } }))).toEqual([]);
	});

	it('compares the days both runs cover from their stored values, so an edit cannot hide behind a date change', () => {
		// The licensing-authority finding: rain cut 15 % and one day added read only "series extended".
		const rain = Array.from({ length: 366 }, (_, i) => (i % 7 === 0 ? 20 : 0));
		const cut = [...rain.map((v) => v * 0.85), 5];
		const snap = (length: number, valuesSha256: string) => snapshot({ series: { rain_catchment_mm: { startDate: '2000-01-01', length, valuesSha256 } } });
		const both = { a: { rain_catchment_mm: rain }, b: { rain_catchment_mm: cut } };
		expect(diffInputs(snap(366, 'aa'), snap(367, 'bb'), both).map((c) => c.text)).toEqual([
			'Rainfall (catchment) series extended to 2001-01-01 (was 2000-12-31)',
			'Rainfall (catchment) values changed on 53 of the 366 days both runs cover (2000-01-01 to 2000-12-31); their total fell 15% (1\u202f060 → 901)'
		]);
		// Only extended, the shared days untouched: just the date change (positive control).
		const extended = { a: { rain_catchment_mm: rain }, b: { rain_catchment_mm: [...rain, 5] } };
		expect(diffInputs(snap(366, 'aa'), snap(367, 'cc'), extended).map((c) => c.text)).toEqual(['Rainfall (catchment) series extended to 2001-01-01 (was 2000-12-31)']);
		// Same dates: the stored values give the count and the total, not just "changed".
		expect(diffInputs(snap(366, 'aa'), snap(366, 'dd'), { a: { rain_catchment_mm: rain }, b: { rain_catchment_mm: cut.slice(0, 366) } })[0]!.text).toMatch(/changed on 53 of the 366 days/);
		// A gap opened counts as a change but stays out of the totals, which then match: no total quoted.
		const gap = rain.map((v, i) => (i === 7 ? null : v));
		expect(diffInputs(snap(366, 'aa'), snap(366, 'ee'), { a: { rain_catchment_mm: rain }, b: { rain_catchment_mm: gap } })[0]!.text).toBe(
			'Rainfall (catchment) values changed on 1 of the 366 days both runs cover (2000-01-01 to 2000-12-31)'
		);
	});

	it('shared days: none when the ranges do not meet, and a shift is compared day by day', () => {
		expect(sharedDaysChange({ startDate: '2000-01-01', values: [1, 2] }, { startDate: '2000-01-03', values: [1] })).toBeNull();
		expect(sharedDaysChange({ startDate: '2000-01-01', values: [1, 2, 3] }, { startDate: '2000-01-02', values: [2, 4] })).toEqual({
			shared: 2,
			changed: 1,
			first: '2000-01-02',
			last: '2000-01-03',
			totalA: 5,
			totalB: 6
		});
	});

	it('describes every WR2012 input: the reference (each field and month), scaling, dry season, thresholds and penalty', () => {
		const monthly = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
		const reference = {
			quaternary: 'Z99A',
			areaKm2: 100,
			marMm3: 12,
			monthlyMm3: monthly,
			periodStart: 1990,
			periodEnd: 2009,
			mapMm: null,
			source: 'Synthetic table 1'
		};
		const a = snapshot();
		const b = structuredClone(a);
		b.settings.wr2012 = { ...defaultProjectSettings().wr2012, reference };
		expect(texts(a, b)).toEqual(['WR2012 reference added (Z99A, MAR 12 Mm³/a over 100 km², 1990/91 – 2009/10)']);
		expect(texts(b, a)).toEqual(['WR2012 reference removed (was Z99A, MAR 12 Mm³/a over 100 km², 1990/91 – 2009/10)']);

		const c = structuredClone(b);
		c.settings.wr2012 = {
			reference: {
				quaternary: 'Z99B',
				areaKm2: 120,
				marMm3: 12.6,
				monthlyMm3: [1.6, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
				periodStart: 1995,
				periodEnd: 2010,
				mapMm: 650,
				source: 'Synthetic table 2'
			},
			scaling: 'areaRain',
			lowFlowMonths: [12, 1, 2],
			flags: { notePct: 5, queryPct: 20, queryWetterPct: 10, unusablePct: 40 },
			calibrationPenalty: { enabled: true, weight: 1, marLowMm3: 5, marHighMm3: 10 }
		};
		expect(texts(b, c)).toEqual([
			'WR2012 quaternary: "Z99A" → "Z99B"',
			'WR2012 quaternary area: 100 km² → 120 km²',
			'WR2012 naturalised MAR: 12 Mm³/a → 12.6 Mm³/a',
			'WR2012 quaternary MAP: not entered → 650 mm',
			'WR2012 reference period start: 1990/91 → 1995/96',
			'WR2012 reference period end: 2009/10 → 2010/11',
			'WR2012 source: "Synthetic table 1" → "Synthetic table 2"',
			'WR2012 monthly means: Oct 1 → 1.6 Mm³',
			'WR2012 scaling: area ratio → area and rainfall ratio',
			'WR2012 dry-season months: from the run → Dec–Feb',
			'WR2012 note threshold: 10 % → 5 %',
			'WR2012 query threshold: 25 % → 20 %',
			'WR2012 query-if-wetter threshold: 15 % → 10 %',
			'WR2012 not-usable threshold: 50 % → 40 %',
			'WR2012 calibration penalty: off → on',
			'WR2012 calibration penalty weight: 0.5 → 1',
			'WR2012 calibration penalty MAR band: none (single target) → 5 – 10 Mm³/a'
		]);
		// Every change sits in the settings area.
		expect(diffInputs(b, c).every((x) => x.area === 'settings')).toBe(true);
		// A run saved before the WR2012 check existed reads as the defaults: no change.
		const old = structuredClone(a);
		delete (old.settings as Record<string, unknown>).wr2012;
		expect(texts(old, a)).toEqual([]);

		// The band changing on its own (weight and enabled the same) is its own line.
		const d = structuredClone(c);
		d.settings.wr2012!.calibrationPenalty = { ...c.settings.wr2012!.calibrationPenalty, marLowMm3: 6, marHighMm3: 10 };
		expect(texts(c, d)).toEqual(['WR2012 calibration penalty MAR band: 5 – 10 Mm³/a → 6 – 10 Mm³/a']);
		const e = structuredClone(c);
		e.settings.wr2012!.calibrationPenalty = { ...c.settings.wr2012!.calibrationPenalty, marLowMm3: null, marHighMm3: null };
		expect(texts(c, e)).toEqual(['WR2012 calibration penalty MAR band: 5 – 10 Mm³/a → none (single target)']);
	});

	it('tolerates missing snapshots (runs stored before a field existed)', () => {
		expect(diffInputs(null, null)).toEqual([]);
		expect(texts(null as unknown as RunInputsSnapshot, snapshot())).toContain('Farm "Rooikloof" added (10 km², dam 600\u202f000 m³, drains into Outlet)');
	});
});

describe('describeCalendarMonths', () => {
	it('groups runs of three or more in water-year order', () => {
		expect(describeCalendarMonths([10, 11, 12, 1, 2, 3])).toBe('Oct–Mar');
		expect(describeCalendarMonths([1, 3, 4, 5])).toBe('Jan, Mar–May');
		expect(describeCalendarMonths([])).toBe('no months');
		expect(describeCalendarMonths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe('all year');
	});
});

describe('Reserve compliance in run comparison (engine ≥ 0.21.0)', () => {
	// Synthetic: two water years of flat natural flow at the 50 % point; B lets less through in the dry months.
	const start = '2000-10-01';
	const days = 366 + 365;
	const rule = (over: Partial<EwrRuleTable> = {}): EwrRuleTable => ({
		siteNodeId: null,
		source: 'Synthetic',
		component: 'total',
		unit: 'mcm',
		points: [10, 50, 90],
		ewr: Array.from({ length: 12 }, () => [1.5, 1, 0.5]),
		naturalSource: 'table',
		natural: Array.from({ length: 12 }, () => [3, 2, 1]),
		scale: 1,
		...over
	});
	const site = (share: number, over: { nodeId?: string | null; name?: string; isOutlet?: boolean; table?: EwrRuleTable } = {}) => {
		const d0 = Date.UTC(2000, 9, 1) / 86_400_000;
		const natural = Float64Array.from({ length: days }, (_, t) => {
			const d = new Date((d0 + t) * 86_400_000);
			return 2e6 / new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
		});
		const impacted = natural.map((v, t) => {
			const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
			return [1, 2, 3].includes(m) ? v * share : v;
		});
		return assessSite(start, days, { table: over.table ?? rule(), nodeId: over.nodeId ?? null, name: over.name ?? 'Outlet', isOutlet: over.isOutlet ?? true, natural, impacted }).report;
	};

	it('is null when neither run has a rule table', () => {
		expect(compareRuns(run(summary([])), run(summary([]))).ewrAssurance).toBeNull();
	});

	it('compares each site’s months met, deficit, contiguity and months of the year', () => {
		// A: every month meets the 1 Mm³ requirement (all at 60 %); B: Jan–Mar at 40 %, so 6 months short.
		const a = site(0.6);
		const b = site(0.4);
		const [row] = compareRuns(run(summary([], { ewrAssurance: [a] })), run(summary([], { ewrAssurance: [b] }))).ewrAssurance!;
		expect(row).toMatchObject({ name: 'Outlet', isOutlet: true, onlyIn: null, tableChanged: false });
		expect(row!.rate).toEqual({ a: 1, b: 18 / 24, delta: expect.closeTo(-0.25, 12) });
		expect(row!.monthsNotMet).toEqual({ a: 0, b: 6, delta: 6 });
		expect(row!.longestNotMetRun.b).toBe(3);
		expect(row!.deficitM3.b).toBeCloseTo(6 * 0.2e6, 3);
		// Jan is water-year month 3.
		expect(row!.byMonth[3]).toEqual({ a: 1, b: 0, delta: -1 });
		expect(row!.byMonth[0]).toEqual({ a: 1, b: 1, delta: 0 });
		// From daily data (CR-29): B is short every day of Jan–Mar, 180 of 730 days, and 1.2 of 24 Mm³ required.
		expect(row!.timeNotMet).toEqual({ a: 0, b: 180 / 730, delta: 180 / 730 });
		expect(row!.volumeNotMet!.a).toBe(0);
		expect(row!.volumeNotMet!.b).toBeCloseTo(0.05, 9);
		// The EWR as %nMAR depends only on natural flow: 12 of 24 Mm³ in both.
		expect(row!.ewrPctNmar!.a).toBeCloseTo(50, 9);
		expect(row!.ewrPctNmar!.delta).toBeCloseTo(0, 9);
	});

	it('matches a gauge by id, then by name across a copy; flags a site in one run only and a changed table', () => {
		const out = site(1);
		const g = site(1, { nodeId: 'g1', name: 'Mid gauge', isOutlet: false });
		const gCopy = site(0.4, { nodeId: 'copy-g1', name: 'Mid gauge', isOutlet: false, table: rule({ scale: 0.5 }) });
		const rows = compareRuns(run(summary([], { ewrAssurance: [out, g] })), run(summary([], { ewrAssurance: [gCopy] }))).ewrAssurance!;
		expect(rows.map((r) => [r.name, r.onlyIn, r.tableChanged])).toEqual([
			['Outlet', 'a', false],
			['Mid gauge', null, true]
		]);
		expect(rows[0]!.rate).toEqual({ a: 1, b: null, delta: null });
	});

	it('lists rule tables added, removed and changed in the inputs, by site name', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.settings.ewrRules = [rule(), rule({ siteNodeId: 'g', source: 'Gauge table', naturalSource: 'run', natural: null })];
		expect(texts(a, b)).toEqual([
			'EWR rule table at the outlet added ("Synthetic", 3 % points, natural percentile from the table)',
			'EWR rule table at Outlet added ("Gauge table", 3 % points, natural percentile from the run)'
		]);
		const c = structuredClone(b);
		c.settings.ewrRules![0]!.ewr[3] = [1.4, 1, 0.5];
		c.settings.ewrRules![0]!.natural![7] = [3, 2, 0.9];
		c.settings.ewrRules![0]!.unit = 'm3s';
		c.settings.ewrRules![0]!.scale = 2;
		c.settings.ewrRules!.pop();
		expect(texts(b, c)).toEqual([
			'EWR rule table at Outlet removed (was "Gauge table")',
			'EWR rule table at the outlet: unit Mm³ per month → m³/s',
			'EWR rule table at the outlet: scale 1 → 2',
			'EWR rule table at the outlet: EWR values changed in Jan',
			'EWR rule table at the outlet: natural flows changed in May'
		]);
		// A run saved before rule tables (no key) compares like none.
		const old = structuredClone(a);
		delete (old.settings as Record<string, unknown>).ewrRules;
		expect(texts(old, a)).toEqual([]);
	});

	it('compares low-flow and high-flow compliance, and flags a changed component as a changed table (engine ≥ 0.33.0)', () => {
		const withLow = rule({ lowFlow: Array.from({ length: 12 }, () => [1, 0.6, 0.2]) });
		// B: Jan–Mar at 40 % of natural (0.8 Mm³): below the 1 Mm³ total, above the 0.6 low flow.
		const a = site(1, { table: withLow });
		const b = site(0.4, { table: withLow });
		const [row] = compareRuns(run(summary([], { ewrAssurance: [a] })), run(summary([], { ewrAssurance: [b] }))).ewrAssurance!;
		expect(row!.tableChanged).toBe(false);
		expect(row!.lowFlowRate).toEqual({ a: 1, b: 1, delta: 0 });
		expect(row!.rate.b).toBe(18 / 24);
		expect(row!.highFlowRate).toEqual({ a: null, b: null, delta: null });
		const fresh = { label: 'Freshet', months: [10], peakM3s: 0.5, durationDays: 3, perYear: 1 };
		const c = site(1, { table: { ...withLow, highFlows: [fresh] } });
		const [changed] = compareRuns(run(summary([], { ewrAssurance: [a] })), run(summary([], { ewrAssurance: [c] }))).ewrAssurance!;
		expect(changed!.tableChanged).toBe(true);
		// Flat 2 Mm³ a month is ~0.75 m³/s, above the 0.5 m³/s peak all year: one event a year, starting 1 October, both years met.
		expect(changed!.highFlowRate).toEqual({ a: null, b: 1, delta: null });
	});

	it('lists a rule table’s kind of source changing (engine ≥ 1.5.0); absent and null are both not stated', () => {
		const a = snapshot();
		a.settings.ewrRules = [rule()];
		const b = structuredClone(a);
		b.settings.ewrRules![0]!.sourceKind = 'desktop';
		expect(texts(a, b)).toEqual(['EWR rule table at the outlet: kind of source not stated → Desktop estimate, low confidence']);
		const c = structuredClone(b);
		c.settings.ewrRules![0]!.sourceKind = 'gazetted';
		expect(texts(b, c)).toEqual(['EWR rule table at the outlet: kind of source Desktop estimate, low confidence → Gazetted Reserve']);
		const d = structuredClone(a);
		d.settings.ewrRules![0]!.sourceKind = null;
		expect(texts(a, d)).toEqual([]);
	});

	it('lists a rule table’s REC changing (ER9); absent and null are both not given', () => {
		const a = snapshot();
		a.settings.ewrRules = [rule()];
		const b = structuredClone(a);
		b.settings.ewrRules![0]!.category = 'B/C';
		expect(texts(a, b)).toEqual(['EWR rule table at the outlet: recommended ecological category (REC) not given → B/C']);
		const c = structuredClone(b);
		c.settings.ewrRules![0]!.category = 'C';
		expect(texts(b, c)).toEqual(['EWR rule table at the outlet: recommended ecological category (REC) B/C → C']);
		const d = structuredClone(a);
		d.settings.ewrRules![0]!.category = null;
		expect(texts(a, d)).toEqual([]);
	});

	it('lists the determination’s natural MAR changing (engine ≥ 1.11.0); absent and null are both not recorded', () => {
		const a = snapshot();
		a.settings.ewrRules = [rule()];
		const b = structuredClone(a);
		b.settings.ewrRules![0]!.naturalMarMcm = 12.5;
		expect(texts(a, b)).toEqual(['EWR rule table at the outlet: natural MAR (determination) not recorded → 12.5 Mm³/a']);
		const c = structuredClone(a);
		c.settings.ewrRules![0]!.naturalMarMcm = null;
		expect(texts(a, c)).toEqual([]);
	});

	it('lists the EWR site list changing: a gauge added, taken off the sites, turned into a farm (engine ≥ 1.5.0)', () => {
		const a = snapshot();
		a.model.nodes.push(node('w', 'Weir', { kind: 'gauge', downstreamNodeId: 'g', damCapacityM3: 0 }));
		// A run saved before the flag (absent) compares equal to one with it set true.
		const flagged = structuredClone(a);
		for (const n of flagged.model.nodes) n.ewrSite = true;
		expect(texts(a, flagged)).toEqual([]);
		const off = structuredClone(a);
		off.model.nodes.find((n) => n.id === 'w')!.ewrSite = false;
		expect(texts(a, off)).toEqual(['Weir: EWR site yes → no', 'EWR sites: Outlet (outlet), Weir → Outlet (outlet) (removed Weir (taken off the EWR sites))']);
		expect(texts(off, a)).toEqual(['Weir: EWR site no → yes', 'EWR sites: Outlet (outlet) → Outlet (outlet), Weir (added Weir (marked as an EWR site))']);
		const none = snapshot();
		expect(texts(none, a)).toEqual(['Gauge "Weir" added (10 km², drains into Outlet)', 'EWR sites: Outlet (outlet) → Outlet (outlet), Weir (added Weir (new node))']);
		const farm = structuredClone(a);
		farm.model.nodes.find((n) => n.id === 'w')!.kind = 'farm';
		expect(texts(a, farm)).toContain('EWR sites: Outlet (outlet), Weir → Outlet (outlet) (removed Weir (now a farm))');
		// Every change line is about the network; a copy of the project (fresh ids) is no change.
		expect(diffInputs(a, off).every((c) => c.area === 'network')).toBe(true);
		expect(diffInputs(off, copyWithFreshIds(off))).toEqual([]);
	});

	it('lists the GN 538 property area and rate changing (engine ≥ 1.12.0); absent and null are the same', () => {
		const a = snapshot();
		const nulls = structuredClone(a);
		for (const n of nulls.model.nodes) Object.assign(n, { gaPropertyAreaHa: null, gaRateM3HaYear: null });
		expect(texts(a, nulls)).toEqual([]);
		const set = structuredClone(a);
		const f = set.model.nodes.find((n) => n.kind === 'farm')!;
		Object.assign(f, { gaPropertyAreaHa: 60, gaRateM3HaYear: 45 });
		expect(texts(a, set)).toEqual([`${f.name}: GN 538 property area not set → 60 ha`, `${f.name}: GN 538 rate not set → 45 m³/ha/a`]);
	});

	it('lists low-flow values and high-flow components changed in the inputs (engine ≥ 0.33.0)', () => {
		const a = snapshot();
		a.settings.ewrRules = [rule()];
		const b = structuredClone(a);
		b.settings.ewrRules![0]!.lowFlow = Array.from({ length: 12 }, () => [1, 0.6, 0.2]);
		b.settings.ewrRules![0]!.highFlows = [{ label: 'Freshet', months: [11], peakM3s: 5, durationDays: 3, perYear: 1 }];
		expect(texts(a, b)).toEqual(['EWR rule table at the outlet: low-flow values added', 'EWR rule table at the outlet: high-flow components none → Freshet']);
		const c = structuredClone(b);
		c.settings.ewrRules![0]!.lowFlow![4] = [1, 0.5, 0.2];
		c.settings.ewrRules![0]!.highFlows![0]!.peakM3s = 6;
		expect(texts(b, c)).toEqual(['EWR rule table at the outlet: low-flow values changed in Feb', 'EWR rule table at the outlet: high-flow components Freshet → Freshet (values changed)']);
		// Absent, null and [] are all none: a table saved before 0.33.0 compares equal to a blank one.
		const d = structuredClone(a);
		d.settings.ewrRules![0]!.lowFlow = null;
		d.settings.ewrRules![0]!.highFlows = [];
		expect(texts(a, d)).toEqual([]);
	});
});

describe('field history tables (settingsChangePaths, nodeChangeFields)', () => {
	it('names the setting a settings line is about, by its subject', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.settings.lakeEvapFactor = 0.6;
		b.settings.gr4j!.x1 += 10;
		const paths = new Map(settingsChangePaths());
		const subjects = diffInputs(a, b).map((c) => c.subject);
		expect(subjects.map((s) => paths.get(s))).toEqual(['lakeEvapFactor', 'gr4j.x1']);
		// One path per subject, no subject twice.
		expect(paths.size).toBe(settingsChangePaths().length);
	});

	it('names the node field a node line is about, by the label after "Name: "', () => {
		const a = snapshot();
		const b = structuredClone(a);
		const f = b.model.nodes.find((n) => n.name === 'Rooikloof')!;
		f.damCapacityM3 += 1000;
		f.irrigationEfficiency = 0.5;
		const labels = nodeChangeFields();
		const keyOf = (text: string) => {
			const rest = text.slice('Rooikloof: '.length);
			return labels.filter(([l]) => rest.startsWith(`${l} `)).sort((x, y) => y[0].length - x[0].length)[0]?.[1];
		};
		expect(diffInputs(a, b).map((c) => keyOf(c.text))).toEqual(['damCapacityM3', 'irrigationEfficiency']);
		expect(new Set(labels.map(([l]) => l)).size).toBe(labels.length);
	});

	it('names the operating rules and supply fields (engine 1.32.0), the monthly rows included', () => {
		const a = snapshot();
		const b = structuredClone(a);
		Object.assign(b.model.nodes.find((n) => n.name === 'Rooikloof')!, {
			supplyRule: 'riverFirst',
			pumpCapacityM3Day: 1200,
			handsOffM3Day: new Array(12).fill(300),
			handsOffEwr: true,
			divertMonthlyM3Day: new Array(12).fill(500)
		});
		const labels = nodeChangeFields();
		const keyOf = (text: string) => {
			const rest = text.slice('Rooikloof: '.length);
			return labels.filter(([l]) => rest.startsWith(`${l} `)).sort((x, y) => y[0].length - x[0].length)[0]?.[1];
		};
		expect(diffInputs(a, b).map((c) => keyOf(c.text)).sort()).toEqual(['divertMonthlyM3Day', 'handsOffEwr', 'handsOffM3Day', 'pumpCapacityM3Day', 'supplyRule']);
	});
});

describe('describeFitRecord', () => {
	it('names the model, the time, the objective without its gloss, and the seed', () => {
		expect(describeFitRecord({ model: 'gr4j', fittedAt: '2026-09-24T14:05:31.123Z', objective: 'kgePrime', seed: 1 })).toBe('GR4J fit of 2026-09-24 14:05 UTC (KGE′, seed 1)');
	});
	// An objective the engine doesn't know is shown as stored. Its trailing "(…)" is dropped without
	// backtracking: `/ \(.*\)$/` rescanned to the end from every " (" (CodeQL js/polynomial-redos).
	// The timeout is a hang guard, not a budget: the engine's default is 120 s, which the old pattern fit inside.
	it('shows an unknown stored objective, and a long run of " (" returns at once', { timeout: 5_000 }, () => {
		const fit = (objective: string) => describeFitRecord({ model: 'gr4j', fittedAt: null as unknown as string, objective: objective as 'kgePrime', seed: 2 });
		expect(fit('custom (old)')).toBe('GR4J fit of unknown time (custom, seed 2)');
		const run = ' ('.repeat(200_000);
		expect(fit(run)).toBe(`GR4J fit of unknown time (${run}, seed 2)`);
	});
});
