import { describe, expect, it } from 'vitest';
import {
	compareRuns,
	describeCalendarMonths,
	diffInputs,
	matchByIdThenName,
	metricDelta,
	type ComparableRun,
	type RunInputsSnapshot
} from './compare';
import { defaultProjectSettings, type FarmSummary, type NetworkNode, type RunSummary } from './project';
import { ewrAgreement } from './network/ewrAgreement';

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
			pooledFactor: { a: 2, b: 2, delta: 0 }, excludedWaterYearsA: [1999], excludedWaterYearsB: [1999], changed: false
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
		b.settings.runoffModel = 'legacy';
		b.settings.effectiveRainStoreMm = 0;
		b.settings.zeroRainRuns = { mode: 'asRecorded', keepDry: [], missing: [] };
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

	it('describes a dam raise on a copied project by farm name', () => {
		const a = snapshot();
		const b = copyWithFreshIds(a);
		b.model.nodes.find((n) => n.name === 'Rooikloof')!.damCapacityM3 = 720_000;
		const d = diffInputs(a, b);
		expect(d).toEqual([
			{ area: 'network', kind: 'changed', subject: 'Rooikloof', text: 'Rooikloof: dam capacity 600,000 m³ → 720,000 m³' }
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
			'Transfer Rooikloof → Bergwater: daily cap none → 4,000 m³',
			'Transfer Rooikloof → Bergwater: minimum source storage 20% → 30%'
		]);
		expect(texts(a2, a)).toEqual(['Transfer Rooikloof → Bergwater removed']);
	});

	it('describes settings: scalars, calibration, monthly tables and unknown keys', () => {
		const a = snapshot();
		const b = structuredClone(a);
		b.settings.calibration!.a = 0.12;
		b.settings.calibration!.summerMonths = [11, 12, 1, 2];
		b.settings.calibration!.recessionFactors = [...a.settings.calibration!.recessionFactors.slice(0, 79), 0.99];
		b.settings.effectiveRainFraction = 0.7;
		b.settings.simulationStart = '2005-10-01';
		(b.settings as Record<string, unknown>).ewrPragmaticM3PerDay = [100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		(b.settings as Record<string, unknown>).apanMm = new Array(12).fill(150);
		b.settings.hiLoSplit = { hi: 0.7, lo: 0.3 };
		(b.settings as Record<string, unknown>).futureKnob = 3;
		expect(texts(a, b)).toEqual([
			'Effective rain fraction: 0.65 → 0.7',
			'Simulation start: start of data → 2005-10-01',
			'A-pan evaporation: changed in 12 months',
			'Pragmatic EWR: Oct 0 → 100 m³/day',
			'Hi/lo MAP split: 0.81/0.19 → 0.7/0.3',
			'Calibration peak flow coefficient a: 0.09 → 0.12',
			'Calibration summer months: Nov–May → Nov–Feb',
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
		expect(texts(old, a)).toEqual(['Flagged zero-rain runs: run as recorded (dry) → treated as missing (CHIRPS fills them)']);
		const recorded = structuredClone(a);
		recorded.settings.zeroRainRuns = { mode: 'asRecorded', keepDry: [], missing: [] };
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

	it('describes a switch of runoff model and GR4J parameter changes', () => {
		const a = snapshot();
		a.settings.runoffModel = 'legacy';
		const b = structuredClone(a);
		b.settings.runoffModel = 'gr4j';
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
			'Rainfall (catchment) series extended back to 1999-12-31 (was 2000-01-01)'
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
			calibrationEnd: '2018-09-30',
			calibrationFlowKind: 'flow_logger_m3s',
			dataQuality: { agreementMinRatio: 0.8 } // stored sparsely: the other two stay at their defaults
		});
		expect(texts(a, b)).toEqual([
			'Curtailment report start: start of run → 2015-10-01',
			'Calibration window end: end of record → 2018-09-30',
			'Calibration flow series: default (observed, else logger) → Logger flow',
			'Data quality gauge/logger lowest ratio: 66.67% → 80%'
		]);
		// A run stored before dataQuality existed compares equal to one with the defaults.
		const old = structuredClone(a);
		delete (old.settings as Record<string, unknown>).dataQuality;
		expect(texts(old, a)).toEqual([]);
	});

	it('treats month lists as sets: order and repeats are not a change', () => {
		const a = snapshot();
		a.model.transfers = [{ id: 't', fromNodeId: 'f1', toNodeId: 'f2', months: [10, 2, 1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0.3, enabled: true, priority: 0 }];
		a.settings.calibration!.summerMonths = [12, 1, 11];
		const b = structuredClone(a);
		b.model.transfers[0]!.months = [1, 2, 10, 10];
		b.settings.calibration!.summerMonths = [1, 11, 12];
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
				expect(texts(a, b), zone).toEqual(['Rainfall (catchment) series extended to 2020-03-01 (was 2020-02-28)']);
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
		// Different dates: only the date change (the hash can't isolate shared days).
		const longer = snapshot({ series: { rain_catchment_mm: { startDate: '2000-01-01', length: 367, valuesSha256: 'cc' } } });
		expect(texts(s('aa'), longer)).toEqual(['Rainfall (catchment) series extended to 2001-01-01 (was 2000-12-31)']);
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
		expect(texts(null as unknown as RunInputsSnapshot, snapshot())).toContain('Farm "Rooikloof" added (10 km², dam 600,000 m³, drains into Outlet)');
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
