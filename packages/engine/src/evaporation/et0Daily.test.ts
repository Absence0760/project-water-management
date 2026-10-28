// Daily reference evapotranspiration (engine ≥ 1.104.0, issue #604 R5-E,
// docs/model.md §2.4a): under a monthly PE row, the `evap_et0_mm` series is
// GR4J's PE as it stands on the days it has a value, the row's share on the
// others, counted and warned; under pan coefficient × A-pan it is not read
// (and the run says so); crop demand and dam evaporation never read it; a
// project without it runs bit-identically. Fit provenance (et0DailyChanged)
// is tested beside the A-pan's in ../calibrate/provenance.test.ts. Synthetic catchment: invented
// values only (public repo).
import { describe, expect, it } from 'vitest';
import { prepareCalibration } from '../calibrate/calibrate';
import { defaultProjectSettings, type DailySeries, type ModelInput, type PeInput } from '../project';
import { prepareRun } from '../prepare';
import { runModel, withVerification } from '../run';
import { GR4J_NO_PET, hasPotentialEvaporation } from '../runoff/pet';
import { runoffForcing } from '../runoff/simulate';
import { applyScenario } from '../scenario';
import { et0DailyInfo, et0DailyMm, hasDailyEt0Value } from './et0Daily';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep, mm/month
const peRow = [110, 130, 150, 160, 130, 110, 75, 45, 30, 30, 45, 75]; // reference ET, mm/month (a climatology)
const DAYS = 730; // 2020-10-01 … 2022-09-30
const START = '2020-10-01';
const MONTHLY: PeInput = { kind: 'monthly', mm: peRow as never, source: 'invented climatology' };

function catchment(settings: ModelInput['settings'] = {}, et0?: DailySeries): ModelInput {
	const node = { sortOrder: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0.5, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 17 === 0 ? 40 : i % 5 === 0 ? 1 : 0));
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, ...settings },
		model: {
			nodes: [
				{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0, pctRunoffToDam: 0 },
				{ ...node, id: 'F', name: 'Farm', kind: 'farm', downstreamNodeId: 'G', areaKm2: 12.5, divertCapacityM3Day: 5000 },
				{ ...node, id: 'D', name: 'Dam farm', kind: 'farm', downstreamNodeId: 'G', areaKm2: 4, pctRunoffToDam: 0, damCapacityM3: 300_000, damInitialPct: 0.8, damAreaFullM2: 60_000 }
			],
			crops: [{ id: 'c', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] as never }],
			cropAreas: [{ nodeId: 'F', cropId: 'c', areaM2: 200_000 }],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: rain },
			flow_observed_m3s: { startDate: START, values: Array.from({ length: DAYS }, (_, t) => 0.05 + 0.001 * (t % 7)) },
			...(et0 ? { evap_et0_mm: et0 } : {})
		}
	};
}

type Out = ReturnType<typeof runModel>;
const col = (out: Out, key: string, nodeId: string | null = null) => {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
};

// The first 100 days carry a daily record of 6 mm (day 10 missing, day 20 negative).
const COVERED = 100;
const daily = (): DailySeries => ({ startDate: START, values: Array.from({ length: COVERED }, (_, i) => (i === 10 ? null : i === 20 ? -3 : 6)) });
const covered = (t: number) => t < COVERED && t !== 10 && t !== 20;

describe('et0DailyMm / et0DailyInfo', () => {
	it('keeps values ≥ 0 and marks the rest NaN; null when no day is usable', () => {
		expect(Array.from(et0DailyMm([4, null, -1, 0, Number.NaN])!)).toEqual([4, NaN, NaN, 0, NaN]);
		expect(et0DailyMm([null, -2])).toBeNull();
		expect(hasDailyEt0Value([0, null])).toBe(false);
		expect(hasDailyEt0Value([0, 3])).toBe(true);
	});

	it('counts daily, fallback and negative days under a monthly row; under pan it is not used, and says so', () => {
		const w: string[] = [];
		expect(et0DailyInfo(undefined, [], 0, MONTHLY, false, w)).toBeNull();
		expect(w).toEqual([]);
		expect(et0DailyInfo({ startDate: START, values: [] }, [3, null, -1, 2], 0, MONTHLY, false, w)).toEqual({ used: true, dailyDays: 2, fallbackDays: 2, invalidDays: 1, first: '1970-01-01', last: '1970-01-04' });
		expect(w[0]).toMatch(/covers 2 of 4 run days .* use the monthly PE row spread over the month, 1 of them with a negative value/);
		const p: string[] = [];
		expect(et0DailyInfo({ startDate: START, values: [] }, [3, 3], 0, { kind: 'pan' }, false, p)).toEqual({ used: false, dailyDays: 0, fallbackDays: 2, invalidDays: 0, first: null, last: null });
		expect(p[0]).toMatch(/is not read: GR4J’s potential evaporation is pan coefficient × A-pan/);
	});
});

describe('runModel with a daily reference ET series', () => {
	const base = runModel(catchment({ pe: MONTHLY }));
	const out = runModel(catchment({ pe: MONTHLY }, daily()));

	it('without the series: bit-identical to a run before the series existed, no summary, no warning (positive control below)', () => {
		expect(base.summary.et0Daily).toBeUndefined();
		expect(base.summary.warnings.some((w) => w.includes('reference evapotranspiration'))).toBe(false);
		expect(out.series).not.toEqual(base.series);
	});

	it('GR4J’s PE is the day’s ET₀ as it stands where present, the monthly row’s share elsewhere', () => {
		const pet = col(out, 'pet');
		const petBase = col(base, 'pet');
		for (let t = 0; t < DAYS; t++) {
			if (covered(t)) expect(pet[t]).toBe(6);
			else expect(pet[t]).toBe(petBase[t]);
		}
		expect(col(out, 'natural_flow')).not.toEqual(col(base, 'natural_flow'));
	});

	it('crop demand and dam evaporation never read it', () => {
		expect(col(out, 'gross_demand', 'F')).toEqual(col(base, 'gross_demand', 'F'));
		const ev = col(out, 'dam_evaporation', 'D');
		// The dam's evaporation moves only through its storage (the flow changed), never by the ET₀: day 0 is identical.
		expect(ev[0]).toBe(col(base, 'dam_evaporation', 'D')[0]);
	});

	it('reports the days in the summary and a warning', () => {
		expect(out.summary.et0Daily).toEqual({ used: true, dailyDays: COVERED - 2, fallbackDays: DAYS - COVERED + 2, invalidDays: 1, first: START, last: '2021-01-08' });
		expect(out.summary.warnings.some((w) => w.includes(`daily reference evapotranspiration covers ${COVERED - 2} of ${DAYS} run days`))).toBe(true);
	});

	it('passes the engine self-checks', () => {
		const v = withVerification(catchment({ pe: MONTHLY }, daily()), out).summary.verification!;
		expect(v.checks.filter((c) => !c.passed)).toEqual([]);
	});

	it('under pan coefficient × A-pan the series changes nothing but the summary and a warning', () => {
		const pan = runModel(catchment({}));
		const panWith = runModel(catchment({}, daily()));
		expect(panWith.series).toEqual(pan.series);
		expect(panWith.summary.et0Daily).toMatchObject({ used: false, dailyDays: 0 });
		expect(panWith.summary.warnings.some((w) => w.includes('is not read'))).toBe(true);
	});

	it('a series that covers no run day gives the monthly results exactly', () => {
		const outside = runModel(catchment({ pe: MONTHLY }, { startDate: '2030-01-01', values: [5, 5] }));
		expect(outside.series).toEqual(base.series);
		expect(outside.summary.warnings.some((w) => w.includes('every day uses the monthly PE row'))).toBe(true);
	});
});

describe('GR4J evaporation from the daily ET₀ alone', () => {
	const zeroRow: PeInput = { kind: 'monthly', mm: new Array(12).fill(0) as never, source: 'none' };
	it('runs under an all-zero monthly row when the series covers the run; refused without it', () => {
		expect(() => runModel(catchment({ pe: zeroRow }))).toThrow(GR4J_NO_PET);
		const out = runModel(catchment({ pe: zeroRow }, { startDate: START, values: new Array(DAYS).fill(4) }));
		expect(col(out, 'pet')[0]).toBe(4);
		expect(hasPotentialEvaporation({ apanMm: apan, panCoefficient: defaultProjectSettings().panCoefficient, pe: zeroRow }, false, true)).toBe(true);
		// Under pan with zero A-pan the daily ET₀ doesn't count: it is never multiplied by a pan coefficient.
		expect(hasPotentialEvaporation({ apanMm: new Array(12).fill(0), panCoefficient: defaultProjectSettings().panCoefficient }, false, true)).toBe(false);
	});

	it('calibration sees the same forcing as the run', () => {
		const input = catchment({ pe: MONTHLY }, daily());
		const p = prepareCalibration(input);
		p.simulate(p.startParams);
		const natural = col(runModel(input), 'natural_flow');
		for (let t = 0; t < DAYS; t++) expect(p.natural[t]).toBeCloseTo(natural[t]!, 6);
		const r = prepareRun(input);
		expect(runoffForcing(r.settings, r).petMm[0]).toBe(6);
	});
});

describe('scenario series.scale on the daily ET₀', () => {
	it('scales the record, which moves GR4J’s PE on the days it covers', () => {
		const { input: scaled } = applyScenario(catchment({ pe: MONTHLY }, daily()), [{ op: 'series.scale', kind: 'evap_et0_mm', factor: 1.1 }]);
		expect(col(runModel(scaled), 'pet')[0]).toBeCloseTo(6.6, 12);
	});
});
