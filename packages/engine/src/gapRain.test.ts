// The gap-filling product (engine ≥ 1.101.0, issue #604 R4-B, settings.gapRain,
// docs/model.md §2.4b *Gap-filling product*). Every record here is synthetic:
// a catchment series wet on about half the days with exponential falls over
// water years 1990–2009, blank over water years 2004–2006; CHIRPS reads it
// smeared over three days at 60 % of its level; ERA5-Land variants read it at
// a known fraction, with or without drizzle; IMERG versions read it at known
// multiples. So each product's factors, wet-day rate and filled days have a
// known answer.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay, type Monthly } from './calendar';
import { diffInputs } from './compare';
import { applyGapRain, GAP_ERA5L_WET_DAY_MM } from './gapRain';
import { prepareRun } from './prepare';
import { defaultProjectSettings, ERA5L_SERIES_KEY, gapRainError, imergSeriesKey, resolveGapRain, type DailySeries, type ModelInput, type NetworkNode } from './project';
import { RAIN_SOURCE_CODE } from './rainSourcePeriods';
import { captureModelState, runModel, runModelFrom } from './run';
import { checkInvariants } from './testing/invariants';
import { tailDifference } from './testing/warmstartInvariants';
import { ensembleContext, memberInput, resolveEnsembleOptions } from './uncertainty/ensemble';

const S = '1989-10-01';
const d0 = toEpochDay(S);
const DAYS = toEpochDay('2009-10-01') - d0;
const GAP_FROM = toEpochDay('2003-10-01');
const GAP_TO = toEpochDay('2006-09-30');
const MEAN = [0, 12, 12, 10, 8, 6, 4, 4, 4, 5, 8, 10, 12];
const P_WET = [0, 0.5, 0.5, 0.5, 0.45, 0.4, 0.3, 0.3, 0.3, 0.35, 0.45, 0.5, 0.5];

function lcg(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return (s + 0.5) / 2 ** 32;
	};
}

const truth: number[] = (() => {
	const rnd = lcg(41);
	const out: number[] = [];
	for (let i = 0; i < DAYS; i++) {
		const m = monthOfEpochDay(d0 + i);
		const u1 = rnd();
		const u2 = rnd();
		out.push(u1 < P_WET[m]! ? -Math.log(u2) * MEAN[m]! : 0);
	}
	return out;
})();
const inGap = (i: number) => d0 + i >= GAP_FROM && d0 + i <= GAP_TO;
const catchment: DailySeries = { startDate: S, values: truth.map((v, i) => (inGap(i) ? null : v)) };
const chirps: DailySeries = { startDate: S, values: truth.map((_, i) => (0.6 * ((truth[i - 1] ?? 0) + truth[i]! + (truth[i + 1] ?? 0))) / 3) };
/** ERA5-Land at half the catchment's level, day for day: every factor is exactly 2. */
const era5Half: DailySeries = { startDate: S, values: truth.map((v) => 0.5 * v) };
/** ERA5-Land as a reanalysis reads it: the rain smeared over five days, plus 0.4 mm of drizzle every day. */
const era5Drizzle: DailySeries = {
	startDate: S,
	values: truth.map((_, i) => {
		let s = 0;
		for (let k = -2; k <= 2; k++) s += truth[i + k] ?? 0;
		return 0.4 + s / 5;
	})
};

const input = (extra: Partial<ModelInput['settings']> = {}, series: ModelInput['series'] = {}): ModelInput => ({
	settings: {
		apanMm: new Array(12).fill(150) as unknown as Monthly,
		calibration: { ...defaultProjectSettings().calibration, catchmentAreaKm2: 10 },
		...extra
	} as ModelInput['settings'],
	model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
	series: { rain_catchment_mm: catchment, rain_chirps_mm: chirps, ...series }
});

const ERA5 = { gapRain: { product: 'era5l' as const, imergLate: false } };
const BOTH = { gapRain: { product: 'chirpsThenEra5l' as const, imergLate: false } };

/** The run's rain_source code per epoch day. */
function sourceCodes(inp: ModelInput): Map<number, number> {
	const out = runModel(inp);
	const col = out.series.find((x) => x.key === 'rain_source')!;
	const s0 = toEpochDay(out.startDate);
	return new Map(col.values.map((v, t) => [s0 + t, v]));
}

describe('settings.gapRain: the setting', () => {
	it('absent, null and CHIRPS alone written out all resolve to null (CHIRPS alone); a bad value warns and falls back', () => {
		const w: string[] = [];
		expect(resolveGapRain(undefined, w)).toBeNull();
		expect(resolveGapRain(null, w)).toBeNull();
		expect(resolveGapRain({ product: 'chirps', imergLate: false }, w)).toBeNull();
		expect(w).toEqual([]);
		expect(resolveGapRain({ product: 'chirps', imergLate: true }, w)).toEqual({ product: 'chirps', imergLate: true });
		expect(resolveGapRain({ product: 'era5', imergLate: false }, w)).toBeNull();
		expect(w[0]).toMatch(/^gap-filling product ignored \(product must be one of chirps, era5l, chirpsThenEra5l\)/);
		expect(gapRainError({ product: 'era5l', imergLate: 'yes' })).toBe('imergLate must be true or false');
		expect(gapRainError({ product: 'era5l', imergLate: false, extra: 1 })).toBe('has unknown field extra');
	});
});

describe('settings.gapRain: the default leaves every run as it was', () => {
	const node = (id: string, over: Partial<NetworkNode> = {}): NetworkNode => ({
		id, name: id, kind: 'farm', downstreamNodeId: null, sortOrder: 0, areaKm2: 20, 
		pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 50_000, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0,
		irrigationEfficiency: 1, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0, ...over
	});
	const networked = (extra: Partial<ModelInput['settings']>, series: ModelInput['series'] = {}): ModelInput => ({
		...input(extra, series),
		model: {
			nodes: [node('A', { downstreamNodeId: 'G' }), node('G', { kind: 'gauge', areaKm2: 0, damCapacityM3: 0 })],
			crops: [{ id: 'c', name: 'Crop', cropFactor: new Array<number>(12).fill(0.8) }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 200_000 }],
			transfers: []
		}
	});

	it('absent, null and CHIRPS alone run bit for bit the same, even with ERA5-Land and IMERG in the input', () => {
		const base = runModel(networked({}));
		const others = { [ERA5L_SERIES_KEY]: era5Half, [imergSeriesKey('V07')]: era5Half } as ModelInput['series'];
		for (const [extra, series] of [
			[{ gapRain: null }, {}],
			[{ gapRain: { product: 'chirps', imergLate: false } }, {}],
			[{}, others],
			[{ gapRain: { product: 'chirps', imergLate: false } }, others]
		] as const) {
			const out = runModel(networked(extra as Partial<ModelInput['settings']>, series));
			expect(out.series).toEqual(base.series);
			expect(out.summary).toEqual(base.summary);
			expect(out.summary.gapRain).toBeUndefined();
		}
	});

	it('the water balance closes under each product choice', () => {
		for (const extra of [ERA5, BOTH, { gapRain: { product: 'chirps' as const, imergLate: true } }]) {
			const inp = networked(extra, { [ERA5L_SERIES_KEY]: era5Drizzle });
			expect(checkInvariants(inp, runModel(inp))).toBeNull();
		}
	});

	it('a run resumed from a snapshot fills the gap days as the full run does (ERA5-Land’s fit and map pinned)', () => {
		const inp = networked({ ...ERA5, simulationStart: '2002-10-01', simulationEnd: '2005-09-30' }, { [ERA5L_SERIES_KEY]: era5Drizzle });
		const full = runModel(inp);
		const at = '2004-01-17';
		const snapshot = captureModelState(inp, at);
		const tailOnly = structuredClone(inp);
		for (const x of Object.values(tailOnly.series)) {
			const cut = toEpochDay(at) - toEpochDay(x!.startDate);
			x!.values = x!.values.slice(cut);
			x!.startDate = at;
		}
		const k = toEpochDay(at) - toEpochDay(full.startDate);
		expect(tailDifference(full, runModelFrom(snapshot, tailOnly), k)).toBeNull();
	});

	it('run comparison names a change of product, and none between absent and CHIRPS alone', () => {
		const snap = (inp: ModelInput) => ({ settings: inp.settings, model: inp.model, series: {} }) as never;
		const changes = diffInputs(snap(input({})), snap(input(ERA5)));
		expect(changes.map((c) => c.text)).toContain('Gap-filling product: CHIRPS → ERA5-Land');
		const same = diffInputs(snap(input({})), snap(input({ gapRain: { product: 'chirps', imergLate: false } })));
		expect(same.filter((c) => c.subject === 'Gap-filling product')).toEqual([]);
	});
});

describe('settings.gapRain: ERA5-Land', () => {
	it('fits its own factors (exactly 2 for ERA5-Land at half the catchment) apart from CHIRPS’, and fills the gap with them', () => {
		const run = prepareRun(input(ERA5, { [ERA5L_SERIES_KEY]: era5Half }));
		const p = run.gapRain!.info.products[0]!;
		expect(p.product).toBe('era5l');
		for (const m of p.correction!.months) expect(m.factor).toBeCloseTo(2, 9);
		// CHIRPS' own fit is unchanged: 1 ÷ 0.6 over the record (smearing keeps the totals but at the record's ends).
		expect(run.chirpsCorrection!.pooled.factor).toBeCloseTo(1 / 0.6, 2);
		// CHIRPS filled nothing; ERA5-Land every gap day.
		expect(run.chirpsCorrection!.fallbackDays).toBe(0);
		expect(run.gapRain!.info.chirpsDays).toBe(0);
		expect(p.days).toBe(GAP_TO - GAP_FROM + 1);
		// The map keeps each whole month's corrected total: 2 × ERA5-Land's, so the gap's rain is the truth's.
		const used = run.aligned('rain_chirps_mm');
		let usedMm = 0;
		let truthMm = 0;
		for (let t = 0; t < run.days; t++) {
			const i = run.start + t - d0;
			if (!inGap(i)) continue;
			usedMm += used[t]!;
			truthMm += truth[i]!;
		}
		expect(usedMm).toBeCloseTo(truthMm, 6);
	});

	it('a wet-day threshold and quantile map take its drizzle away: the gap’s wet-day rate moves to the catchment’s, every month total kept', () => {
		const run = prepareRun(input(ERA5, { [ERA5L_SERIES_KEY]: era5Drizzle }));
		const p = run.gapRain!.info.products[0]!;
		const qm = p.correction!.quantileMap!;
		expect(qm.wetDayMm).toBe(GAP_ERA5L_WET_DAY_MM);
		// ERA5-Land is wet (≥ 1 mm) far more often than the catchment, so its own thresholds rise above 1 mm.
		for (const m of qm.months) if (m.basis) expect(m.chirpsWetMm).toBeGreaterThan(1);
		const used = run.aligned('rain_chirps_mm');
		const wet = { raw: 0, mapped: 0, truth: 0, n: 0, drizzleRaw: 0, drizzleMapped: 0 };
		const monthMm = new Map<string, { mapped: number; raw: number }>();
		for (let t = 0; t < run.days; t++) {
			const i = run.start + t - d0;
			if (!inGap(i)) continue;
			const raw = era5Drizzle.values[i]!;
			const v = used[t]!;
			wet.n++;
			if (raw >= 1) wet.raw++;
			if (v >= 1) wet.mapped++;
			if (truth[i]! >= 1) wet.truth++;
			if (raw > 0 && raw < 1) wet.drizzleRaw++;
			if (v > 0 && v < 1) wet.drizzleMapped++;
			const key = fromEpochDay(run.start + t).slice(0, 7);
			const mm = monthMm.get(key) ?? { mapped: 0, raw: 0 };
			mm.mapped += v;
			mm.raw += raw * p.correction!.months[monthOfEpochDay(run.start + t) - 1]!.factor!;
			monthMm.set(key, mm);
		}
		expect(wet.raw / wet.n).toBeGreaterThan(0.75);
		expect(Math.abs(wet.mapped / wet.n - wet.truth / wet.n)).toBeLessThan(0.05);
		expect(wet.drizzleRaw).toBeGreaterThan(0);
		// Drizzle goes dry; a wet day rescaled to its month total can land just under 1 mm, rarely.
		expect(wet.drizzleMapped * 50).toBeLessThan(wet.drizzleRaw);
		// Each whole gap month keeps its factor-corrected total.
		for (const [key, mm] of monthMm) expect(mm.mapped, key).toBeCloseTo(mm.raw, 6);
	});

	it('with CHIRPS first, ERA5-Land fills only the gap days CHIRPS has no value for', () => {
		const hole = (i: number) => d0 + i >= toEpochDay('2004-10-01') && d0 + i <= toEpochDay('2005-09-30');
		const holed: DailySeries = { startDate: S, values: chirps.values.map((v, i) => (hole(i) ? null : v)) };
		const chirpsOnly = prepareRun(input({}, { rain_chirps_mm: holed }));
		const run = prepareRun(input(BOTH, { rain_chirps_mm: holed, [ERA5L_SERIES_KEY]: era5Half }));
		const codes = sourceCodes(input(BOTH, { rain_chirps_mm: holed, [ERA5L_SERIES_KEY]: era5Half }));
		const a = chirpsOnly.aligned('rain_chirps_mm');
		const b = run.aligned('rain_chirps_mm');
		// The hole is whole months: ERA5-Land × 2, mapped with each month's total kept, gives each month the truth's rain.
		const months = new Map<string, { used: number; truth: number }>();
		for (let t = 0; t < run.days; t++) {
			const i = run.start + t - d0;
			if (!inGap(i)) continue;
			if (hole(i)) {
				expect(codes.get(run.start + t)).toBe(RAIN_SOURCE_CODE.era5l);
				const key = fromEpochDay(run.start + t).slice(0, 7);
				const m = months.get(key) ?? { used: 0, truth: 0 };
				m.used += b[t]!;
				m.truth += truth[i]!;
				months.set(key, m);
			} else {
				expect(codes.get(run.start + t)).toBe(RAIN_SOURCE_CODE.chirps);
				expect(b[t]).toBe(a[t]);
			}
		}
		expect(months.size).toBe(12);
		for (const [key, m] of months) expect(m.used, key).toBeCloseTo(m.truth, 6);
		expect(run.gapRain!.info.segments).toEqual([{ from: '2004-10-01', to: '2005-09-30', product: 'era5l', version: null }]);
		expect(run.gapRain!.info.chirpsDays).toBe(GAP_TO - GAP_FROM + 1 - 365);
	});

	it('the double-mass check runs against each product: a step in ERA5-Land shows against it, not against CHIRPS', () => {
		const step: DailySeries = { startDate: S, values: truth.map((v, i) => (d0 + i < toEpochDay('1999-10-01') ? 0.5 : 1) * v) };
		const run = prepareRun(input(ERA5, { [ERA5L_SERIES_KEY]: step }));
		const dm = run.gapRain!.info.products[0]!.doubleMass!;
		expect(dm.breaks.length).toBeGreaterThan(0);
		expect(Math.abs(dm.breaks[0]!.afterWaterYear - 1998)).toBeLessThanOrEqual(1);
		expect(run.doubleMass?.breaks ?? []).toEqual([]);
		expect(run.warnings.some((w) => w.startsWith('The double-mass check of catchment rain against ERA5-Land finds 1 break'))).toBe(true);
	});

	it('in CHIRPS’ place, CHIRPS’ own double-mass break warns of no day (it fills none)', () => {
		const stepC: DailySeries = { startDate: S, values: chirps.values.map((v, i) => (d0 + i < toEpochDay('1999-10-01') ? 0.5 : 1) * v!) };
		const chirpsAlone = prepareRun(input({}, { rain_chirps_mm: stepC }));
		expect(chirpsAlone.warnings.some((w) => w.startsWith('CHIRPS fills catchment-rain gaps with factors fitted on the whole record'))).toBe(true);
		const run = prepareRun(input(ERA5, { rain_chirps_mm: stepC, [ERA5L_SERIES_KEY]: era5Half }));
		expect(run.doubleMass!.breaks.length).toBeGreaterThan(0);
		expect(run.warnings.some((w) => w.startsWith('CHIRPS fills catchment-rain gaps'))).toBe(false);
	});

	it('the uncertainty ensemble’s CHIRPS-only member runs on CHIRPS alone, whatever the gap-filling product', () => {
		const inp: ModelInput = {
			...input({ ...ERA5, simulationStart: '2000-10-01', simulationEnd: '2008-09-30' }, { [ERA5L_SERIES_KEY]: era5Drizzle }),
			model: {
				nodes: [
					{ id: 'A', name: 'A', kind: 'farm', downstreamNodeId: 'G', sortOrder: 0, areaKm2: 20, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 },
					{ id: 'G', name: 'G', kind: 'gauge', downstreamNodeId: null, sortOrder: 1, areaKm2: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 }
				] as NetworkNode[],
				crops: [],
				cropAreas: [],
				transfers: []
			}
		};
		inp.series.flow_observed_m3s = { startDate: '2000-10-01', values: Array.from({ length: 2922 }, (_, i) => 1 + (i % 7) / 10) };
		const { options } = resolveEnsembleOptions(inp, { members: 30, rainSources: ['chirps'] });
		const ctx = ensembleContext(inp, options, false);
		const m = memberInput(ctx, { index: 0, reference: true, params: ctx.startParams, panOffset: 0, rain: 'chirps', record: options.records[0]! });
		expect(m.settings.gapRain).toBeNull();
		const member = prepareRun(m);
		expect(member.gapRain).toBeNull();
		expect(member.aligned('rain_chirps_mm')).toEqual(prepareRun({ ...m, series: { ...m.series, [ERA5L_SERIES_KEY]: undefined } as ModelInput['series'] }).aligned('rain_chirps_mm'));
	});

	it('warns when the settings choose ERA5-Land and the run has none, and the gaps fall through', () => {
		const run = prepareRun(input(ERA5));
		expect(run.warnings.some((w) => w.startsWith('the gap-filling product is ERA5-Land, but the run has no ERA5-Land rain'))).toBe(true);
		const used = run.aligned('rain_chirps_mm');
		for (let t = 0; t < run.days; t++) if (inGap(run.start + t - d0)) expect(used[t]).toBeNull();
	});
});

describe('settings.gapRain: IMERG Late for the recent days', () => {
	const END_C = toEpochDay('2009-09-10');
	const END_H = toEpochDay('2009-09-20');
	const cut = (s: DailySeries, end: number): DailySeries => ({ startDate: s.startDate, values: s.values.slice(0, end - d0 + 1) });
	/** IMERG V07 at twice the truth from 2000 to 2009-09-25; V08 at four times it from 2005 to 2009-09-30. */
	const v07: DailySeries = { startDate: '2000-06-01', values: truth.slice(toEpochDay('2000-06-01') - d0, toEpochDay('2009-09-25') - d0 + 1).map((v) => 2 * v) };
	const v08: DailySeries = { startDate: '2005-01-01', values: truth.slice(toEpochDay('2005-01-01') - d0, toEpochDay('2009-09-30') - d0 + 1).map((v) => 4 * v) };
	const series = { rain_catchment_mm: cut(catchment, END_C), rain_chirps_mm: cut(chirps, END_H), [imergSeriesKey('V07')]: v07, [imergSeriesKey('V08')]: v08 } as ModelInput['series'];
	const IMERG = { gapRain: { product: 'chirps' as const, imergLate: true } };

	it('fits each version on its own (factors 0.5 and 0.25) and fills only the days past CHIRPS’ last, the newest version first', () => {
		const run = prepareRun(input(IMERG, series));
		const info = run.gapRain!.info;
		expect(info.tailFrom).toBe('2009-09-21');
		const byVersion = new Map(info.products.map((p) => [p.version, p]));
		for (const m of byVersion.get('V07')!.correction!.months) expect(m.factor).toBeCloseTo(0.5, 9);
		for (const m of byVersion.get('V08')!.correction!.months) expect(m.factor).toBeCloseTo(0.25, 9);
		expect(info.segments).toEqual([{ from: '2009-09-21', to: '2009-09-30', product: 'imerg_late', version: 'V08' }]);
		expect(byVersion.get('V08')!.days).toBe(10);
		expect(byVersion.get('V07')!.days).toBe(0);
		// The tail's rain is the truth, through V08's own factor.
		const used = run.aligned('rain_chirps_mm');
		for (let day = toEpochDay('2009-09-21'); day <= toEpochDay('2009-09-30'); day++) expect(used[day - run.start]).toBeCloseTo(truth[day - d0]!, 9);
		// The run reaches IMERG's last day.
		expect(run.end).toBe(toEpochDay('2009-09-30'));
		// The gap of 2004–2006 is CHIRPS': IMERG never fills a day before the tail.
		const codes = sourceCodes(input(IMERG, series));
		for (let day = GAP_FROM; day <= GAP_TO; day++) expect(codes.get(day)).toBe(RAIN_SOURCE_CODE.chirps);
		for (let day = toEpochDay('2009-09-21'); day <= toEpochDay('2009-09-30'); day++) expect(codes.get(day)).toBe(RAIN_SOURCE_CODE.imergLate);
	});

	it('labels each tail day with the version that filled it, an older version where the newer lacks the day', () => {
		const v08Late: DailySeries = { startDate: '2009-09-24', values: truth.slice(toEpochDay('2009-09-24') - d0, toEpochDay('2009-09-30') - d0 + 1).map((v) => 4 * v) };
		const run = prepareRun(input(IMERG, { ...series, [imergSeriesKey('V08')]: v08Late }));
		expect(run.gapRain!.info.segments).toEqual([
			{ from: '2009-09-21', to: '2009-09-23', product: 'imerg_late', version: 'V07' },
			{ from: '2009-09-24', to: '2009-09-30', product: 'imerg_late', version: 'V08' }
		]);
		// V08 has no overlap with the catchment now: its days run uncorrected, and the run says so.
		expect(run.warnings.some((w) => w.startsWith('IMERG Late V08 fills 7 catchment-rain gap days') && w.includes('uncorrected'))).toBe(true);
	});

	it('gives the same tail and version segments at UTC+14 and UTC−11', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const v08Late: DailySeries = { startDate: '2009-09-24', values: truth.slice(toEpochDay('2009-09-24') - d0, toEpochDay('2009-09-30') - d0 + 1).map((v) => 4 * v) };
		const at = () => {
			const r = prepareRun(input(IMERG, { ...series, [imergSeriesKey('V08')]: v08Late }));
			return JSON.stringify([r.gapRain!.info.tailFrom, r.gapRain!.info.segments, r.aligned('rain_chirps_mm')]);
		};
		try {
			env.TZ = 'UTC';
			const utc = at();
			env.TZ = 'Pacific/Kiritimati';
			expect(at()).toBe(utc);
			env.TZ = 'Pacific/Pago_Pago';
			expect(at()).toBe(utc);
			expect(JSON.parse(utc)[0]).toBe('2009-09-21');
		} finally {
			env.TZ = tz;
		}
	});

	it('a blank day CHIRPS has no value for inside the record is not IMERG’s', () => {
		const holed: DailySeries = { startDate: S, values: chirps.values.slice(0, END_H - d0 + 1).map((v, i) => (d0 + i >= toEpochDay('2005-01-01') && d0 + i <= toEpochDay('2005-01-31') ? null : v)) };
		const run = prepareRun(input(IMERG, { ...series, rain_chirps_mm: holed }));
		const used = run.aligned('rain_chirps_mm');
		for (let day = toEpochDay('2005-01-01'); day <= toEpochDay('2005-01-31'); day++) expect(used[day - run.start]).toBeNull();
	});
});

describe('applyGapRain on its own', () => {
	it('a blocked day takes no product', () => {
		const days = 3;
		const start = toEpochDay('2020-01-01');
		const r = applyGapRain({
			gap: { product: 'era5l', imergLate: false },
			fits: [{ key: ERA5L_SERIES_KEY, correction: null }],
			series: { [ERA5L_SERIES_KEY]: { startDate: '2020-01-01', values: [1, 2, 3] } } as ModelInput['series'],
			base: [null, null, null],
			catchment: [null, null, 5],
			block: Uint8Array.from([0, 1, 0]),
			month: Uint8Array.from([1, 1, 1]),
			start,
			days,
			zeroRain: defaultProjectSettings().zeroRainRuns,
			align: (s, a, n) => Array.from({ length: n }, (_, t) => s!.values[a + t - toEpochDay(s!.startDate)] ?? null),
			warnings: []
		});
		expect(r.values).toEqual([1, null, null]);
		expect([...r.code]).toEqual([RAIN_SOURCE_CODE.era5l, -1, -1]);
	});
});
