// The CHIRPS gap map (engine ≥ 1.47.0, CR-23, settings.chirpsQuantileMap,
// docs/model.md §2.4b *Quantile map*). Every record here is synthetic: a
// catchment series wet on about half the days with exponential falls over
// water years 1990–2009, dry through the winter (JJA) so that season is too
// thin to map, and nearly dry in September so it maps on its season; and a
// CHIRPS series that reads the catchment's rain smeared over three days at
// 60 % of its level, so it is wet more often with far fewer heavy days. The
// catchment record is blank over water years 2004–2006: CHIRPS fills them.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearOf, type Monthly } from './calendar';
import { prepareRun } from './prepare';
import { chirpsQuantileMapError, defaultProjectSettings, resolveChirpsQuantileMap, type DailySeries, type ModelInput, type SeriesKind } from './project';
import { heavyDayShare, QM_MIN_WET_DAYS } from './quantileMap';
import {
	chirpsCorrectionWarning,
	chirpsFactorOn,
	chirpsQuantileMapFallbackWarning,
	chirpsQuantileMapText
} from './rain';
import { runModel } from './run';
import { compareRuns, diffInputs } from './compare';
import { checkInvariants } from './testing/invariants';
import { checkChirpsGapMap } from './verify/checks';

const S = '1989-10-01';
const d0 = toEpochDay(S);
const DAYS = toEpochDay('2009-10-01') - d0;
const GAP_FROM = toEpochDay('2003-10-01');
const GAP_TO = toEpochDay('2006-09-30');
/** Mean wet-day fall at the catchment, mm, by calendar month. */
const MEAN = [0, 12, 12, 10, 8, 6, 4, 4, 4, 5, 8, 10, 12];
/** Chance a day is wet at the catchment, by calendar month: dry winter, nearly dry September. */
const P_WET = [0, 0.5, 0.5, 0.5, 0.45, 0.4, 0.005, 0.005, 0.005, 0.04, 0.45, 0.5, 0.5];

function lcg(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return (s + 0.5) / 2 ** 32;
	};
}

function build() {
	const rnd = lcg(23);
	const truth: number[] = [];
	for (let i = 0; i < DAYS; i++) {
		const m = monthOfEpochDay(d0 + i);
		const u1 = rnd();
		const u2 = rnd();
		truth.push(u1 < P_WET[m]! ? -Math.log(u2) * MEAN[m]! : 0);
	}
	const c = truth.map((v, i) => (d0 + i >= GAP_FROM && d0 + i <= GAP_TO ? null : v));
	const h = truth.map((_, i) => 0.6 * ((truth[i - 1] ?? 0) + truth[i]! + (truth[i + 1] ?? 0)) / 3);
	return { rain_catchment_mm: { startDate: S, values: c }, rain_chirps_mm: { startDate: S, values: h } } as Partial<Record<SeriesKind, DailySeries>>;
}
const SERIES = build();
const chirps = SERIES.rain_chirps_mm!;

const input = (extra: Partial<ModelInput['settings']> = {}, series = SERIES): ModelInput => ({
	settings: {
		apanMm: new Array(12).fill(150) as unknown as Monthly,
		calibration: { ...defaultProjectSettings().calibration, catchmentAreaKm2: 10 },
		...extra
	} as ModelInput['settings'],
	model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
	series
});
const MAP = { chirpsQuantileMap: { wetDayMm: 1 } };

/** Rain used on the gap days, keyed by epoch day, and the run. */
function gapRain(inp: ModelInput) {
	const run = prepareRun(inp);
	const rain = run.aligned('rain_catchment_mm');
	const used = run.aligned('rain_chirps_mm');
	const out = new Map<number, number>();
	for (let t = 0; t < run.days; t++) {
		const day = run.start + t;
		if (rain[t] === null && used[t] !== null) out.set(day, used[t]!);
	}
	return { run, out };
}

const factorOnly = (corr: Parameters<typeof chirpsFactorOn>[0], day: number) => chirps.values[day - d0]! * chirpsFactorOn(corr, day)!;
const yearMonth = (day: number) => fromEpochDay(day).slice(0, 7);

describe('CHIRPS gap map: off by default', () => {
	it('absent or null, the gap days take CHIRPS × the monthly factor exactly, the correction has no quantileMap and the run is the same', () => {
		const a = gapRain(input());
		const b = gapRain(input({ chirpsQuantileMap: null }));
		expect(a.out.size).toBe(GAP_TO - GAP_FROM + 1);
		for (const [day, v] of a.out) expect(v).toBe(factorOnly(a.run.chirpsCorrection, day));
		expect('quantileMap' in a.run.chirpsCorrection!).toBe(false);
		expect(JSON.stringify(b.run.chirpsCorrection)).toBe(JSON.stringify(a.run.chirpsCorrection));
		expect([...b.out]).toEqual([...a.out]);
		expect(a.run.warnings.some((w) => /quantile/i.test(w))).toBe(false);
		const ra = runModel(input());
		const rb = runModel(input({ chirpsQuantileMap: null }));
		expect(JSON.stringify(rb.summary)).toBe(JSON.stringify(ra.summary));
		expect(ra.series.some((x) => x.key === 'rain_chirps_mapped')).toBe(false);
	});
});

describe('CHIRPS gap map: fit', () => {
	const { run } = gapRain(input(MAP));
	const q = run.chirpsCorrection!.quantileMap!;

	it('fits per calendar month on the fit period, the season for a thin month, nothing for a thin season', () => {
		expect(q.wetDayMm).toBe(1);
		expect(q.minWetDays).toBe(QM_MIN_WET_DAYS);
		const basis = q.months.map((m) => m.basis);
		// Oct–May map on their own wet days; June–August (a dry winter) not even over the season; September on SON.
		for (const m of [1, 2, 3, 4, 5, 10, 11, 12]) expect(basis[m - 1]).toBe('month');
		for (const m of [6, 7, 8]) expect(basis[m - 1]).toBeNull();
		expect(basis[8]).toBe('season');
		expect(q.tables!.map((t) => t !== null)).toEqual(basis.map((b) => b !== null));
		// Wet days counted on the fit's shared days only: none in the gap years.
		const jan = q.months[0]!;
		expect(jan.catchmentWetDays).toBeGreaterThanOrEqual(QM_MIN_WET_DAYS);
		// Smeared, CHIRPS is wet more often: its sample is cut to the catchment's wet-day count (the days are paired).
		expect(jan.chirpsWetMm).toBeGreaterThan(1);
		expect(Math.abs(jan.chirpsWetDays - jan.catchmentWetDays)).toBeLessThanOrEqual(2);
		expect(q.months[8]!.catchmentWetDays).toBeGreaterThanOrEqual(QM_MIN_WET_DAYS); // SON pooled
	});

	it('is fitted in mode monthly only: under none it is ignored with a warning', () => {
		const r = prepareRun(input({ ...MAP, chirpsBiasCorrection: 'none' }));
		expect(r.chirpsCorrection!.quantileMap).toBeUndefined();
		expect(r.settings.chirpsQuantileMap).toBeNull();
		expect(r.warnings).toContain('CHIRPS quantile map ignored: it maps bias-corrected CHIRPS, and CHIRPS bias correction is off (Settings → CHIRPS bias correction)');
	});

	it('an unusable setting is off, with the reason', () => {
		expect(chirpsQuantileMapError(null)).toBeNull();
		expect(chirpsQuantileMapError({ wetDayMm: 1 })).toBeNull();
		expect(chirpsQuantileMapError({ wetDayMm: 0.05 })).toBe('wet-day threshold must be 0.1–10 mm');
		expect(chirpsQuantileMapError({ wetDayMm: 11 })).toBe('wet-day threshold must be 0.1–10 mm');
		expect(chirpsQuantileMapError({ wetDayMm: 1, era: 2000 })).toBe('has unknown field era');
		expect(chirpsQuantileMapError([1])).toBe('is not { wetDayMm }');
		const w: string[] = [];
		expect(resolveChirpsQuantileMap({ wetDayMm: '1' }, w)).toBeNull();
		expect(w).toEqual(['CHIRPS quantile map ignored (wet-day threshold must be 0.1–10 mm): CHIRPS gap days take the monthly factor alone']);
		const r = prepareRun(input({ chirpsQuantileMap: { wetDayMm: 50 } as never }));
		expect(r.chirpsCorrection!.quantileMap).toBeUndefined();
	});
});

describe('CHIRPS gap map: what it keeps', () => {
	const off = gapRain(input());
	const on = gapRain(input(MAP));
	const corr = on.run.chirpsCorrection!;
	const q = corr.quantileMap!;
	const mappedMonth = (day: number) => q.tables![monthOfEpochDay(day) - 1] !== null;

	it('every gap month keeps its factor-corrected total exactly; unmapped months keep the factor value, and below its threshold a mapped month is dry', () => {
		const tot = (m: Map<number, number>) => {
			const t = new Map<string, number>();
			for (const [day, v] of m) t.set(yearMonth(day), (t.get(yearMonth(day)) ?? 0) + v);
			return t;
		};
		const a = tot(off.out);
		const b = tot(on.out);
		expect([...b.keys()]).toEqual([...a.keys()]);
		for (const [k, v] of a) expect(b.get(k)!).toBeCloseTo(v, 9);
		// A month with rain but no day at its threshold can't be mapped and keeps the factor values.
		const thr = (day: number) => q.months[monthOfEpochDay(day) - 1]!.chirpsWetMm;
		const wetMonth = new Set([...off.out].filter(([d, x]) => mappedMonth(d) && x >= thr(d)).map(([d]) => yearMonth(d)));
		let kept = 0;
		for (const [day, v] of on.out) {
			const x = off.out.get(day)!;
			if (!mappedMonth(day) || !wetMonth.has(yearMonth(day))) {
				expect(v).toBe(x);
				if (mappedMonth(day)) kept++;
			} else if (x < thr(day)) expect(v).toBe(0);
			else expect(v).toBeGreaterThan(0);
		}
		expect(kept).toBeLessThan(on.out.size / 10);
	});

	it("matches CHIRPS' wet-day rate to the catchment's: the smeared series is wet more often, so its threshold rises", () => {
		for (const x of q.months) {
			if (x.basis === null) continue;
			expect(x.chirpsWetMm).toBeGreaterThan(q.wetDayMm);
			// The CHIRPS sample is cut to the catchment's wet-day count (the fit's days are paired), ties aside.
			expect(Math.abs(x.chirpsWetDays - x.catchmentWetDays)).toBeLessThanOrEqual(2);
		}
		// Over the gap, in the mapped months, the wet-day rate after the map is near the catchment's over the fitted years.
		const rate = (vals: number[]) => vals.filter((v) => v >= q.wetDayMm).length / vals.length;
		const mappedGap = (m: Map<number, number>) => [...m].filter(([d]) => mappedMonth(d)).map(([, v]) => v);
		const fitted: number[] = [];
		for (let i = 0; i < DAYS; i++) {
			const v = SERIES.rain_catchment_mm!.values[i];
			if (v != null && q.tables![monthOfEpochDay(d0 + i) - 1] !== null) fitted.push(v);
		}
		expect(rate(mappedGap(off.out))).toBeGreaterThan(rate(fitted) + 0.2);
		expect(Math.abs(rate(mappedGap(on.out)) - rate(fitted))).toBeLessThan(0.1);
	});

	it("keeps each month's wet days in order and wet, and moves its rain toward the catchment's heavy days", () => {
		const byMonth = new Map<string, [number, number][]>();
		for (const [day, v] of on.out) {
			const x = off.out.get(day)!;
			if (!mappedMonth(day) || x < q.months[monthOfEpochDay(day) - 1]!.chirpsWetMm) continue;
			const k = yearMonth(day);
			byMonth.set(k, [...(byMonth.get(k) ?? []), [x, v]]);
		}
		expect(byMonth.size).toBeGreaterThan(20);
		for (const pairs of byMonth.values()) {
			const sorted = [...pairs].sort((p, r) => p[0] - r[0]);
			for (let i = 1; i < sorted.length; i++) if (sorted[i]![0] > sorted[i - 1]![0]) expect(sorted[i]![1]).toBeGreaterThanOrEqual(sorted[i - 1]![1]);
			for (const [, v] of pairs) expect(v).toBeGreaterThan(0);
		}
		// The heavy-day share (≥ 20 mm) of the gap rain, against the catchment's own over the fitted years.
		const fitted: number[] = [];
		for (let i = 0; i < DAYS; i++) {
			const v = SERIES.rain_catchment_mm!.values[i];
			if (v != null) fitted.push(v);
		}
		const ref = heavyDayShare(fitted, 20).share!;
		const before = heavyDayShare(off.out.values(), 20).share!;
		const after = heavyDayShare(on.out.values(), 20).share!;
		expect(before).toBeLessThan(ref - 0.2);
		expect(Math.abs(after - ref)).toBeLessThan(Math.abs(before - ref) / 3);
	});

	it('counts what it did and says so, and warns for the gap days it leaves to the factor alone', () => {
		expect(q.mappedDays).toBeGreaterThan(100);
		const winter = [...on.out.keys()].filter((d) => [6, 7, 8].includes(monthOfEpochDay(d))).length;
		expect(q.unmappedDays).toBe(winter);
		let sum = 0;
		for (const v of off.out.values()) sum += v;
		expect(q.factorOnlyMm).toBeCloseTo(sum, 6);
		expect(corr.fallbackCorrectedMm).toBeCloseTo(sum, 6); // every month's total kept, so the gap total too
		expect(chirpsQuantileMapText(q)).toMatch(
			/^wet days \(≥ 1 mm\) quantile-mapped onto the catchment rain's wet days over the fit period, CHIRPS' wet-day threshold raised to match the catchment's wet-day rate in Oct \(\d+\.\d mm\), Nov .*, Sep \(\d+\.\d mm\), days below the threshold dry and each calendar month's corrected total kept; by month: Oct, Nov, Dec, Jan, Feb, Mar, Apr, May; by season: Sep; not mapped \(fewer than 30 wet days even over the season\): Jun, Jul, Aug$/
		);
		expect(chirpsCorrectionWarning(corr)).toContain(`Quantile map (Settings → CHIRPS quantile map): ${chirpsQuantileMapText(q)}. ${q.mappedDays} gap days changed (`);
		const fb = chirpsQuantileMapFallbackWarning(corr)!;
		expect(fb).toBe(
			`CHIRPS quantile map falls back to the monthly factor alone on ${winter} gap days (Jun, Jul, Aug): those months have fewer than 30 wet days (≥ 1 mm) on the catchment or the CHIRPS side over the fit period, even pooled over their 3-month season. Their gap days keep CHIRPS’ own wet-day distribution, at the catchment’s level.`
		);
		expect(on.run.warnings).toContain(fb);
		expect(chirpsQuantileMapFallbackWarning(off.run.chirpsCorrection)).toBeNull();
	});

	it('a gap day reads the same whatever the run window: the month block is the whole stored month', () => {
		const mid = runModel(input({ ...MAP, simulationStart: '2004-01-17', simulationEnd: '2005-03-09' }));
		const full = runModel(input(MAP));
		const at = (r: ReturnType<typeof runModel>, key: string, day: number) => r.series.find((x) => x.nodeId === null && x.key === key)!.values[day - toEpochDay(r.startDate)]!;
		for (const iso of ['2004-01-17', '2004-01-20', '2004-02-05', '2005-03-01', '2005-03-09']) {
			const day = toEpochDay(iso);
			expect(at(mid, 'rain_used', day)).toBe(at(full, 'rain_used', day));
		}
		// The mapped column is what a gap day reads, on every day.
		for (const [day, v] of on.out) expect(at(full, 'rain_chirps_mapped', day)).toBe(v);
		// The summary keeps the fit's counts and months but not its tables.
		expect(full.summary.chirpsCorrection!.quantileMap!.tables).toBeUndefined();
		expect(full.summary.chirpsCorrection!.quantileMap!.months).toEqual(q.months);
	});

	it('with listed fit ranges each day is scaled by its own range factor before it is mapped', () => {
		const ranges = [
			{ fromWaterYear: 1989, toWaterYear: 1998, reason: 'old network' },
			{ fromWaterYear: 1999, toWaterYear: 2008, reason: 'new network' }
		];
		const plain = gapRain(input({ chirpsFitPeriod: ranges }));
		const mapped = gapRain(input({ ...MAP, chirpsFitPeriod: ranges }));
		const c = mapped.run.chirpsCorrection!;
		expect(c.fitPeriod!.segments).toHaveLength(2);
		for (const [day, v] of plain.out) expect(v).toBe(factorOnly(c, day));
		const tot = (m: Map<number, number>, k: string) => [...m].filter(([d]) => yearMonth(d) === k).reduce((s, [, v]) => s + v, 0);
		for (const k of ['2004-01', '2005-11', '2006-03']) expect(tot(mapped.out, k)).toBeCloseTo(tot(plain.out, k), 9);
		expect(waterYearOf(GAP_FROM)).toBe(2003);
	});

	it('a resumed run uses the pinned tables: the capture fit carries them', () => {
		const r = prepareRun(input(MAP), { captureFits: true });
		expect(r.fits!.chirpsCorrection!.quantileMap!.tables).toEqual(q.tables);
		expect(r.fits!.chirpsCorrection!.quantileMap!.mappedDays).toBe(0); // captured before the run counts
		const pinned = prepareRun(input(MAP), { pinned: r.fits! });
		expect([...gapRain(input(MAP)).out.values()]).toEqual(
			[...Array(pinned.days).keys()].flatMap((t) => (pinned.aligned('rain_catchment_mm')[t] === null && pinned.aligned('rain_chirps_mm')[t] !== null ? [pinned.aligned('rain_chirps_mm')[t]!] : []))
		);
	});
});

describe('CHIRPS gap map: run comparison', () => {
	it('names the setting in "What changed" and the map in the CHIRPS fit note', () => {
		const diff = diffInputs({ settings: {} } as never, { settings: { chirpsQuantileMap: { wetDayMm: 1 } } } as never);
		expect(diff.map((c) => c.text)).toContain('CHIRPS quantile map: off (the monthly factor alone) → on (wet days ≥ 1 mm)');
		expect(diffInputs({ settings: { chirpsQuantileMap: null } } as never, { settings: {} } as never).some((c) => /quantile/.test(c.text))).toBe(false);
		const a = runModel(input());
		const b = runModel(input(MAP));
		const cmp = (x: typeof a, y: typeof a) => compareRuns({ engineVersion: '1', startDate: x.startDate, endDate: x.endDate, summary: x.summary }, { engineVersion: '1', startDate: y.startDate, endDate: y.endDate, summary: y.summary }).chirpsFit!;
		const c = cmp(a, b);
		expect(c.changed).toBe(true);
		expect(c.quantileMapA).toBeNull();
		expect(c.quantileMapB).toBe(chirpsQuantileMapText(b.summary.chirpsCorrection!.quantileMap));
		// Positive control: the same map is no change, and two runs without one carry no map fields.
		expect(cmp(b, runModel(input(MAP))).changed).toBe(false);
		expect('quantileMapA' in cmp(a, runModel(input()))).toBe(false);
	});
});

describe('CHIRPS gap map: invariants through a run', () => {
	const node = (id: string, over: Partial<NetworkNode> = {}): NetworkNode => ({
		id, name: id, kind: 'farm', downstreamNodeId: null, sortOrder: 0, areaKm2: 20, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null,
		pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0,
		irrigationEfficiency: 1, lossReturnFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0, ...over
	});
	const withNetwork = (extra: Partial<ModelInput['settings']>): ModelInput => ({
		...input(extra),
		model: {
			nodes: [node('A', { downstreamNodeId: 'G', damCapacityM3: 50_000 }), node('G', { kind: 'gauge', areaKm2: 0 })],
			crops: [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(0.8) as unknown as Monthly }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 200_000 }],
			transfers: []
		}
	});

	it('the water balance closes and every whole month of the mapped column keeps the corrected total, from any start', () => {
		for (const extra of [MAP, { ...MAP, simulationStart: '2004-01-17', simulationEnd: '2005-12-09' }]) {
			const inp = withNetwork(extra);
			const out = runModel(inp);
			expect(out.series.some((x) => x.key === 'rain_chirps_mapped')).toBe(true);
			expect(checkInvariants(inp, out)).toBeNull();
			expect(checkChirpsGapMap(out)).toBeNull();
		}
	});

	it('the month check catches a mapped column that moves rain out of a month (a positive control for the check)', () => {
		const out = runModel(withNetwork(MAP));
		const col = out.series.find((x) => x.key === 'rain_chirps_mapped')!;
		const t = col.values.findIndex((v, i) => i > 40 && v > 0);
		col.values[t] = col.values[t]! + 1;
		expect(checkChirpsGapMap(out)).toMatch(/^rain_chirps_mapped totals /);
	});
});
