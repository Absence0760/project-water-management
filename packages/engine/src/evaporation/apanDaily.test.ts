// Daily A-pan evaporation (engine ≥ 0.38.0, issue #45, docs/model.md §2.3a):
// the `evap_apan_mm` series replaces the monthly A-pan mean on the days it
// has a value, for GR4J's PE (pan coefficient × A-pan), crop demand and dam
// evaporation; other days fall back to the monthly mean, counted and warned.
// Synthetic catchment: invented values only (public repo).
import { describe, expect, it } from 'vitest';
import { prepareCalibration } from '../calibrate/calibrate';
import { defaultProjectSettings, type DailySeries, type ModelInput, type PeInput } from '../project';
import { prepareRun } from '../prepare';
import { runModel, withVerification } from '../run';
import { GR4J_NO_PET, hasPotentialEvaporation } from '../runoff/pet';
import { runoffForcing } from '../runoff/simulate';
import { waterYearIndex } from '../calendar';
import { applyScenario } from '../scenario';
import { apanDailyInfo, apanDailyMm, hasDailyApanValue } from './apanDaily';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep, mm/month
const cropFactor = [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7];
const DAYS = 730; // 2020-10-01 … 2022-09-30
const START = '2020-10-01';
const Kp = defaultProjectSettings().panCoefficient;

/**
 * Two farms draining to a gauge. F irrigates 20 ha of one crop; D has a dam
 * that takes no runoff and supplies nothing, so its evaporation depends on
 * rain on the dam and A-pan only. Observed flow on every day, so the
 * calibration problem scores the whole run.
 */
function catchment(settings: ModelInput['settings'] = {}, evap?: DailySeries): ModelInput {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0.5, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, lossReturnFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 17 === 0 ? 40 : i % 5 === 0 ? 1 : 0));
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, ...settings },
		model: {
			nodes: [
				{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0, pctRunoffToDam: 0 },
				{ ...node, id: 'F', name: 'Farm', kind: 'farm', downstreamNodeId: 'G', areaKm2: 12.5, divertCapacityM3Day: 5000 },
				{ ...node, id: 'D', name: 'Dam farm', kind: 'farm', downstreamNodeId: 'G', areaKm2: 4, pctRunoffToDam: 0, damCapacityM3: 300_000, damInitialPct: 0.8, damAreaFullM2: 60_000 }
			],
			crops: [{ id: 'c', name: 'Lucerne', cropFactor: cropFactor as never }],
			cropAreas: [{ nodeId: 'F', cropId: 'c', areaM2: 200_000 }],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: rain },
			flow_observed_m3s: { startDate: START, values: new Array(DAYS).fill(0.05) },
			...(evap ? { evap_apan_mm: evap } : {})
		}
	};
}

type Out = ReturnType<typeof runModel>;
const col = (out: Out, key: string, nodeId: string | null = null) => {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
};
/** Water-year month (0 = Oct) of run day t. */
const wy = (t: number) => waterYearIndex(new Date(Date.parse(`${START}T00:00:00Z`) + t * 86_400_000).getUTCMonth() + 1);

// The first 100 days carry a daily record of 7 mm (day 10 missing, day 20 negative).
const COVERED = 100;
const daily = (): DailySeries => ({
	startDate: START,
	values: Array.from({ length: COVERED }, (_, i) => (i === 10 ? null : i === 20 ? -3 : 7))
});
const covered = (t: number) => t < COVERED && t !== 10 && t !== 20;

describe('apanDailyMm / apanDailyInfo', () => {
	it('keeps values ≥ 0 and marks the rest NaN; null when no day is usable', () => {
		const a = apanDailyMm([4, null, -1, 0, Number.NaN]);
		expect(Array.from(a!)).toEqual([4, NaN, NaN, 0, NaN]);
		expect(apanDailyMm([null, -2])).toBeNull();
		expect(hasDailyApanValue([0, null])).toBe(false);
		expect(hasDailyApanValue([0, 3])).toBe(true);
	});

	it('counts daily, fallback and negative days, and warns only about a fallback', () => {
		const w: string[] = [];
		expect(apanDailyInfo(undefined, [], 0, false, w)).toBeNull();
		expect(w).toEqual([]);
		const full = apanDailyInfo({ startDate: '2020-01-01', values: [1, 2] }, [1, 2], 18262, false, w);
		expect(full).toEqual({ dailyDays: 2, fallbackDays: 0, invalidDays: 0, first: '2020-01-01', last: '2020-01-02' });
		expect(w).toEqual([]);
		const part = apanDailyInfo({ startDate: '2020-01-01', values: [] }, [null, 5, -1, 6], 18262, true, w);
		expect(part).toEqual({ dailyDays: 2, fallbackDays: 2, invalidDays: 1, first: '2020-01-02', last: '2020-01-04' });
		expect(w).toHaveLength(1);
		expect(w[0]).toContain('covers 2 of 4 run days (2020-01-02 to 2020-01-04); the other 2 use the monthly A-pan mean');
		expect(w[0]).toContain('1 of them with a negative value');
		expect(w[0]).toContain('monthly A-pan means are 0');
		const none = apanDailyInfo({ startDate: '2020-01-01', values: [] }, [null, null], 18262, false, w);
		expect(none).toEqual({ dailyDays: 0, fallbackDays: 2, invalidDays: 0, first: null, last: null });
		expect(w[1]).toContain('no value ≥ 0 inside the run, so every day uses the monthly A-pan means');
	});
});

describe('runModel with a daily A-pan series', () => {
	const base = runModel(catchment());
	const out = runModel(catchment({}, daily()));

	it('without the series: no apanDaily summary and no A-pan warning (positive control for the rest)', () => {
		expect(base.summary.apanDaily).toBeUndefined();
		expect(base.summary.warnings.some((w) => w.includes('A-pan'))).toBe(false);
		// The series changes the outputs below, so equality here isn't vacuous.
		expect(out.series).not.toEqual(base.series);
	});

	it('uses the daily value for GR4J PE (pan coefficient × A-pan) where present, the monthly mean elsewhere', () => {
		const pet = col(out, 'pet');
		const petBase = col(base, 'pet');
		for (let t = 0; t < DAYS; t++) {
			if (covered(t)) expect(pet[t]).toBeCloseTo(Kp[wy(t)]! * 7, 12);
			else expect(pet[t]).toBe(petBase[t]);
		}
		expect(pet[0]).not.toBe(petBase[0]);
	});

	it('uses the daily value for crop demand where present, the monthly mean elsewhere', () => {
		const gross = col(out, 'gross_demand', 'F');
		const grossBase = col(base, 'gross_demand', 'F');
		for (let t = 0; t < DAYS; t++) {
			if (covered(t)) expect(gross[t]).toBeCloseTo((200_000 * cropFactor[wy(t)]! * 7) / 1000, 9);
			else expect(gross[t]).toBe(grossBase[t]);
		}
	});

	it('uses the daily value for dam evaporation where present', () => {
		const area = col(out, 'dam_area', 'D');
		const ev = col(out, 'dam_evaporation', 'D');
		expect(ev[0]).toBeCloseTo((0.75 * 7 * area[0]!) / 1000, 9);
		// Day 10 has no daily value: October's mean, 150 mm over 31 days.
		expect(ev[10]).toBeCloseTo((0.75 * (150 / 31) * area[10]!) / 1000, 9);
	});

	it('reports the fallback days in the summary and warnings', () => {
		expect(out.summary.apanDaily).toEqual({ dailyDays: COVERED - 2, fallbackDays: DAYS - COVERED + 2, invalidDays: 1, first: START, last: '2021-01-08' });
		expect(out.summary.warnings.some((w) => w.includes(`covers ${COVERED - 2} of ${DAYS} run days`) && w.includes('1 of them with a negative value'))).toBe(true);
	});

	it('passes the engine self-checks, including the dam workings', () => {
		const v = withVerification(catchment({}, daily()), out).summary.verification!;
		expect(v.checks.filter((c) => !c.passed)).toEqual([]);
	});

	it('a series that covers no run day gives the monthly results exactly, with a warning', () => {
		const outside = runModel(catchment({}, { startDate: '2030-01-01', values: [5, 5] }));
		expect(outside.series).toEqual(base.series);
		expect(outside.summary.apanDaily).toEqual({ dailyDays: 0, fallbackDays: DAYS, invalidDays: 0, first: null, last: null });
		expect(outside.summary.warnings.some((w) => w.includes('every day uses the monthly A-pan means'))).toBe(true);
	});

	it('under a monthly PE, GR4J ignores it while demand and dams still read it', () => {
		const pe: PeInput = { kind: 'monthly', mm: apan.map((v) => v * 0.7) as never, source: 'invented' };
		const m = runModel(catchment({ pe }));
		const md = runModel(catchment({ pe }, daily()));
		expect(col(md, 'pet')).toEqual(col(m, 'pet'));
		expect(col(md, 'natural_flow')).toEqual(col(m, 'natural_flow'));
		expect(col(md, 'gross_demand', 'F')).not.toEqual(col(m, 'gross_demand', 'F'));
	});
});

describe('GR4J evaporation from the daily series alone', () => {
	const allDays = (): DailySeries => ({ startDate: START, values: new Array(DAYS).fill(5) });

	it('runs when the monthly means are 0 but the daily series covers the run', () => {
		const zero = new Array(12).fill(0);
		expect(() => runModel(catchment({ apanMm: zero as never }))).toThrow(GR4J_NO_PET);
		const out = runModel(catchment({ apanMm: zero as never }, allDays()));
		expect(col(out, 'pet')[0]).toBeCloseTo(Kp[0]! * 5, 12);
		expect(out.summary.apanDaily?.fallbackDays).toBe(0);
		expect(hasPotentialEvaporation({ apanMm: zero, panCoefficient: Kp }, true)).toBe(true);
		expect(hasPotentialEvaporation({ apanMm: zero, panCoefficient: Kp, pe: { kind: 'monthly', mm: zero as never, source: 'x' } }, true)).toBe(false);
	});

	it('calibration sees the same forcing as the run', () => {
		const input = catchment({}, daily());
		const p = prepareCalibration(input);
		p.simulate(p.startParams);
		const natural = col(runModel(input), 'natural_flow');
		for (let t = 0; t < DAYS; t++) expect(p.natural[t]).toBeCloseTo(natural[t]!, 6);
		// And the forcing is the run's: runoffForcing over prepareRun's aligned series.
		const r = prepareRun(input);
		expect(runoffForcing(r.settings, r).petMm[0]).toBeCloseTo(Kp[0]! * 7, 12);
	});
});

describe('scenario series.scale on the daily A-pan', () => {
	it('scales the daily record, which moves crop demand on the days it covers', () => {
		const input = catchment({}, daily());
		const { input: scaled } = applyScenario(input, [{ op: 'series.scale', kind: 'evap_apan_mm', factor: 1.1 }]);
		expect(scaled.series.evap_apan_mm!.values[0]).toBeCloseTo(7.7, 12);
		const out = runModel(scaled);
		expect(col(out, 'gross_demand', 'F')[0]).toBeCloseTo((200_000 * cropFactor[0]! * 7.7) / 1000, 9);
	});
});
