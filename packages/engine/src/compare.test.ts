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
		returnFlowPct: 0.1,
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
		expect(diffInputs(a, snapshot())).toEqual([]);
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
		b.model.nodes[1]!.returnFlowPct = 0.15;
		b.model.nodes[2]!.name = 'Bergwater Suid'; // same id → rename
		b.model.nodes[2]!.downstreamNodeId = 'f1';
		b.model.nodes.push(node('f3', 'Klipfontein', { damCapacityM3: 0 }));
		const c = structuredClone(a);
		c.model.nodes = c.model.nodes.filter((n) => n.id !== 'f2');
		expect(texts(a, b)).toEqual([
			'Farm "Klipfontein" added (10 km², drains into Outlet)',
			'Rooikloof: return flow 10% → 15%',
			'Bergwater Suid: renamed from "Bergwater"',
			'Bergwater Suid: drains into Rooikloof (was Outlet)'
		]);
		expect(texts(a, c)).toEqual(['Farm "Bergwater" removed']);
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
		const t = { id: 't1', fromNodeId: 'f1', toNodeId: 'f2', months: [10, 11, 12, 1, 2, 3], maxRateM3s: 0.05, dailyCapM3: null, minStoragePct: 0.2, enabled: true };
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
				flow_pitman_m3s: { startDate: '2000-01-01', length: 31 }
			}
		});
		expect(texts(a, b)).toEqual([
			'Observed flow series removed',
			'Pitman flow series added (2000-01-01 to 2000-01-31)',
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
		a.model.transfers = [{ id: 't', fromNodeId: 'f1', toNodeId: 'f2', months: [10, 2, 1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0.3, enabled: true }];
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
