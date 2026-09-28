// Sensitivity runs (CR-21, docs/model.md §2.10g): each factor moves the EWR
// results the way the hydrology says it must, factors that can't apply are
// skipped with a reason, and the verdict reads the envelope against the
// threshold. A synthetic catchment throughout.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { CropArea, CropDef, ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { blankEwrRuleTable } from '../reserve/rules';
import { ENGINE_VERSION } from '../version';
import {
	SENSITIVITY_RANGES,
	SENSITIVITY_THRESHOLDS,
	sensitivityRuns,
	siteVerdict,
	type SensitivityResult,
	type SensitivitySite,
	type SiteValues
} from './sensitivity';

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
	irrigationEfficiency: 0.8,
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

/** Seasonal synthetic rain: wet summers, dry winters, the odd storm. */
function rain(days: number, start: string, seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(start);
	return Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		const wet = [11, 12, 1, 2, 3].includes(m) ? 0.35 : 0.08;
		return rng.bool(wet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}

const crop: CropDef = { id: 'c', name: 'Lucerne', cropFactor: [0.9, 1, 1, 1, 1, 0.9, 0.7, 0.6, 0.6, 0.6, 0.7, 0.8] };

/**
 * Two units draining to the outlet gauge: one with a dam that catches its
 * runoff and the upstream flow and irrigates from it, one without. The EWR
 * is set so that it is met on some days and not on others.
 */
function synthetic(opts: { dam?: boolean; crops?: boolean; years?: number } = {}): ModelInput {
	const start = '2000-10-01';
	const days = Math.round((opts.years ?? 4) * 365.25);
	const dam = opts.dam ?? true;
	const withCrops = opts.crops ?? true;
	const cropAreas: CropArea[] = withCrops ? [{ nodeId: 'F2', cropId: 'c', areaM2: 1.5e6 }] : [];
	return {
		settings: {
			runoffModel: 'gr4j',
			apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] as never,
			gr4j: { x1: 420, x2: 0, x3: 85, x4: 2.1, warmupDays: 365 },
			ewrPragmaticM3PerDay: [6000, 9000, 12000, 15000, 15000, 12000, 8000, 5000, 4000, 4000, 4000, 5000] as never
		},
		model: {
			nodes: [
				node({ id: 'G', name: 'Gauge', kind: 'gauge' }),
				node({ id: 'F1', name: 'Upper unit', downstreamNodeId: 'F2', areaKm2: 25 }),
				node({
					id: 'F2',
					name: 'Lower unit',
					downstreamNodeId: 'G',
					areaKm2: 15,
					...(dam ? { pctRunoffToDam: 1, pctUpstreamToDam: 0.5, damCapacityM3: 1.5e6, damInitialPct: 0.5, damAreaFullM2: 5e5 } : {})
				})
			],
			crops: withCrops ? [crop] : [],
			cropAreas,
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: start, values: rain(days, start, 7) } }
	};
}

const at = (r: SensitivityResult, factor: string) => r.factors.find((f) => f.factor === factor)!;

describe('sensitivityRuns: each factor moves the EWR results the right way', () => {
	const input = synthetic();
	const r = sensitivityRuns(input);
	const c = r.central[0]!;

	it('runs every factor on a project with rain, PE from the pan, a dam and demand, one outlet site', () => {
		expect(r.engineVersion).toBe(ENGINE_VERSION);
		expect(r.factors.map((f) => f.factor)).toEqual(['rain', 'pan', 'lakeEvap', 'abstraction', 'damStorage']);
		expect(r.skipped).toEqual([]);
		expect(r.sites).toEqual([{ key: 'outlet', name: 'Gauge', isOutlet: true, hasRuleTable: false }]);
		expect(r.ranges).toEqual(SENSITIVITY_RANGES);
		// A synthetic EWR that is met on some days and not on others: the direction tests below mean something.
		expect(c.daysNotMet).toBeGreaterThan(0);
		expect(c.daysNotMet).toBeLessThan(r.days);
		expect(c.daysMet).toBeCloseTo(1 - c.daysNotMet / r.days, 5);
	});

	it('more rain, fewer EWR days not met and a smaller shortfall', () => {
		const f = at(r, 'rain');
		expect(f.low.label).toBe('× 0.9');
		expect(f.high.values[0]!.daysNotMet).toBeLessThan(c.daysNotMet);
		expect(f.low.values[0]!.daysNotMet).toBeGreaterThan(c.daysNotMet);
		expect(f.high.values[0]!.shortfallMm3).toBeLessThan(c.shortfallMm3);
		expect(f.low.values[0]!.shortfallMm3).toBeGreaterThan(c.shortfallMm3);
	});

	it('a higher pan coefficient (more evaporation), a larger shortfall', () => {
		const f = at(r, 'pan');
		expect(f.high.values[0]!.shortfallMm3).toBeGreaterThan(c.shortfallMm3);
		expect(f.low.values[0]!.shortfallMm3).toBeLessThan(c.shortfallMm3);
		expect(f.high.values[0]!.daysNotMet).toBeGreaterThanOrEqual(f.low.values[0]!.daysNotMet);
	});

	it('more dam evaporation, no smaller shortfall (less spills from the dam)', () => {
		const f = at(r, 'lakeEvap');
		expect(f.high.values[0]!.shortfallMm3).toBeGreaterThanOrEqual(c.shortfallMm3);
		expect(f.low.values[0]!.shortfallMm3).toBeLessThanOrEqual(c.shortfallMm3);
		expect(f.high.values[0]!.shortfallMm3).toBeGreaterThan(f.low.values[0]!.shortfallMm3);
	});

	it('more abstraction, a larger shortfall', () => {
		const f = at(r, 'abstraction');
		expect(f.notes).toEqual(['units’ demand']);
		expect(f.high.values[0]!.shortfallMm3).toBeGreaterThan(c.shortfallMm3);
		expect(f.low.values[0]!.shortfallMm3).toBeLessThan(c.shortfallMm3);
	});

	it('a dam that starts full, no larger shortfall than one that starts empty', () => {
		const f = at(r, 'damStorage');
		expect([f.low.label, f.high.label]).toEqual(['empty', 'full']);
		expect([f.low.setting, f.high.setting]).toEqual([0, 1]);
		expect(f.high.values[0]!.shortfallMm3).toBeLessThanOrEqual(f.low.values[0]!.shortfallMm3);
		expect(f.high.values[0]!.shortfallMm3).toBeLessThan(f.low.values[0]!.shortfallMm3);
	});

	it('is deterministic, reports progress for each run, and leaves the input alone', () => {
		const before = JSON.stringify(input);
		const seen: number[] = [];
		const again = sensitivityRuns(input, { onProgress: (p) => seen.push(p.done) });
		expect(again).toEqual(r);
		expect(seen).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
		expect(JSON.stringify(input)).toBe(before);
	});

	it('takes other multipliers, and leaves out a factor on request', () => {
		const wide = sensitivityRuns(input, { ranges: { rain: { low: 0.8, high: 1.2 } }, skip: ['pan', 'damStorage'] });
		expect(wide.factors.map((f) => f.factor)).toEqual(['rain', 'lakeEvap', 'abstraction']);
		expect(wide.skipped.map((s) => [s.factor, s.reason])).toEqual([
			['pan', 'left out by request'],
			['damStorage', 'left out by request']
		]);
		expect(at(wide, 'rain').high.values[0]!.daysNotMet).toBeLessThanOrEqual(at(r, 'rain').high.values[0]!.daysNotMet);
		expect(() => sensitivityRuns(input, { ranges: { rain: { low: 1, high: 1 } } })).toThrow(/must differ/);
		expect(() => sensitivityRuns(input, { ranges: { rain: { low: 0, high: 1.1 } } })).toThrow(/above 0/);
		expect(() => sensitivityRuns(input, { thresholds: { daysMet: 1.5 } })).toThrow(/from 0 to 1/);
	});

	it('gives a verdict on the envelope of every run, with the default threshold', () => {
		const v = r.verdicts[0]!;
		const all = [c, ...r.factors.flatMap((f) => [f.low.values[0]!, f.high.values[0]!])].map((x) => x.daysMet);
		expect(v.metric).toBe('daysMet');
		expect(v.threshold).toBe(SENSITIVITY_THRESHOLDS.daysMet);
		expect(v.min).toBe(Math.min(...all));
		expect(v.max).toBe(Math.max(...all));
		expect(v.central).toBe(c.daysMet);
	});
});

describe('sensitivityRuns: factors that do not apply', () => {
	it('skips dam evaporation, dam storage and abstraction without a dam or demand, saying why', () => {
		const r = sensitivityRuns(synthetic({ dam: false, crops: false }));
		expect(r.factors.map((f) => f.factor)).toEqual(['rain', 'pan']);
		expect(r.skipped).toEqual([
			{ factor: 'lakeEvap', label: 'Dam evaporation factor', reason: 'the model has no dam' },
			{ factor: 'abstraction', label: 'Abstraction (demand)', reason: 'no unit or other water user has any demand over the reporting window' },
			{ factor: 'damStorage', label: 'Initial dam storage', reason: 'the model has no dam' }
		]);
	});

	it('skips the pan coefficient under a monthly PE row, and dam evaporation when it is off', () => {
		const base = synthetic();
		const input: ModelInput = {
			...base,
			settings: { ...base.settings, lakeEvapFactor: 0, pe: { kind: 'monthly', mm: [120, 140, 160, 170, 140, 120, 80, 50, 35, 35, 50, 80], source: 'Invented' } }
		};
		const r = sensitivityRuns(input);
		expect(r.skipped.map((s) => s.factor)).toEqual(['pan', 'lakeEvap']);
		expect(r.skipped[0]!.reason).toMatch(/monthly PE row/);
		expect(r.skipped[1]!.reason).toBe('dam evaporation is off (factor 0)');
	});

	it('scales an other water user’s demand too', () => {
		const base = synthetic();
		const user = node({ id: 'U', name: 'Town', kind: 'user', downstreamNodeId: 'G', userDemandM3Day: [...new Array(12).fill(2000)] } as Partial<NetworkNode>);
		const input: ModelInput = { ...base, model: { ...base.model, nodes: [...base.model.nodes, user] } };
		const r = sensitivityRuns(input, { skip: ['rain', 'pan', 'lakeEvap', 'damStorage'] });
		const f = at(r, 'abstraction');
		expect(f.notes).toEqual(['units’ demand and other water users’ demand']);
		expect(f.high.values[0]!.shortfallMm3).toBeGreaterThan(r.central[0]!.shortfallMm3);
	});
});

describe('sensitivityRuns with a Reserve rule table', () => {
	it('judges the site on the months meeting its table', () => {
		const base = synthetic();
		const table = { ...blankEwrRuleTable(null), source: 'Invented test table', ewr: Array.from({ length: 12 }, () => [0.5, 0.4, 0.3, 0.3, 0.2, 0.2, 0.1, 0.1, 0.05, 0.01]) };
		const r = sensitivityRuns({ ...base, settings: { ...base.settings, ewrRules: [table] } }, { skip: ['pan', 'lakeEvap', 'abstraction', 'damStorage'] });
		expect(r.sites[0]!.hasRuleTable).toBe(true);
		expect(r.central[0]!.reserveRate).not.toBeNull();
		expect(r.verdicts[0]!.metric).toBe('reserveRate');
		expect(r.verdicts[0]!.threshold).toBe(SENSITIVITY_THRESHOLDS.reserveRate);
		// More rain, no fewer months met.
		expect(at(r, 'rain').high.values[0]!.reserveRate!).toBeGreaterThanOrEqual(at(r, 'rain').low.values[0]!.reserveRate!);
	});
});

describe('siteVerdict', () => {
	const site: SensitivitySite = { key: 'outlet', name: 'Outlet', isOutlet: true, hasRuleTable: false };
	const v = (daysMet: number, reserveRate: number | null = null): SiteValues => ({ daysNotMet: 0, daysMet, shortfallMm3: 0, reserveRate });
	const t = { daysMet: 0.8, reserveRate: 0.9 };

	it('meets when the whole range is at or above the threshold', () => {
		const x = siteVerdict(site, [v(0.85), v(0.8), v(0.95)], v(0.85), t);
		expect(x).toMatchObject({ verdict: 'meets', min: 0.8, max: 0.95, central: 0.85, threshold: 0.8, metric: 'daysMet' });
		expect(x.text).toBe('Outlet: meets the threshold on every sensitivity run: days the EWR was met 80 % to 95 % across the sensitivity runs (central 85 %), against a threshold of 80 %.');
	});

	it('fails when the whole range is below it', () => {
		expect(siteVerdict(site, [v(0.5), v(0.79)], v(0.6), t).verdict).toBe('fails');
	});

	it('is not determinable when the range crosses it, even with the central value clear of it', () => {
		const x = siteVerdict(site, [v(0.9), v(0.75), v(0.97)], v(0.9), t);
		expect(x.verdict).toBe('notDeterminable');
		expect(x.text).toMatch(/^Outlet: not determinable with current data: /);
	});

	it('uses the Reserve rate and its threshold at a site with a rule table, and says when there is nothing to judge', () => {
		const table = { ...site, hasRuleTable: true };
		expect(siteVerdict(table, [v(0.1, 0.92), v(0.1, 0.95)], v(0.1, 0.93), t)).toMatchObject({ metric: 'reserveRate', threshold: 0.9, verdict: 'meets' });
		expect(siteVerdict(table, [v(0.1, null)], v(0.1, null), t)).toMatchObject({ verdict: 'noData', min: null, max: null });
	});
});
