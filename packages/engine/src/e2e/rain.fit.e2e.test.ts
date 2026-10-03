// End-to-end: rain-source 'fit' factors and the reanalysis fallback (docs/model.md
// §2.4e), the CHIRPS quantile map at its extremes (§2.4b *Quantile map*), and the
// rain summaries' counts agreeing with the daily rain the run used.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { fromEpochDay, toEpochDay } from '../calendar';

const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const NODE = {
	sortOrder: 0,
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
	damSeepagePerDay: 0
};
function catchment(series: ModelInput['series'], settings: Record<string, unknown> = {}): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', apanMm: APAN as never, gr4j: { warmupDays: 0 }, ...settings } as unknown as ModelInput['settings'],
		model: {
			nodes: [
				{ ...NODE, id: 'G', name: 'Outlet gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
				{ ...NODE, id: 'F', name: 'Unit A', kind: 'farm', downstreamNodeId: 'G', areaKm2: 10 }
			] as never,
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series
	};
}
const col = (out: ModelOutput, key: string) => out.series.find((s) => s.nodeId === null && s.key === key)?.values;
const span = (from: string, to: string) => {
	const a = toEpochDay(from);
	return Array.from({ length: toEpochDay(to) - a + 1 }, (_, i) => a + i);
};
const ref = (d: number) => 1 + (((d % 7) + 7) % 7);

describe("rain-source 'fit' factors and a reanalysis fallback", () => {
	// WY 2012–2016 the primary reads 2 × the reanalysis; WY 2017 is replaced by an alt gauge reading 0.8 × reanalysis.
	const days = span('2012-10-01', '2018-09-30');
	const d0 = days[0]!;
	const p0 = toEpochDay('2017-10-01');
	const primary = days.map((d) => (d >= p0 ? 50 : 2 * ref(d))); // nonsense in the period: never read
	const alt: (number | null)[] = days.filter((d) => d >= p0).map((d) => 0.8 * ref(d));
	alt[40] = null; // one day the alt gauge lacks
	const series = {
		rain_catchment_mm: { startDate: fromEpochDay(d0), values: primary },
		rain_reanalysis_mm: { startDate: fromEpochDay(d0), values: days.map(ref) },
		rain_catchment_alt_mm: { startDate: '2017-10-01', values: alt as never }
	};
	const period = {
		start: '2017-10-01',
		end: '2018-09-30',
		series: 'rain_catchment_alt_mm' as const,
		factors: 'fit' as const,
		fitReference: { series: 'rain_reanalysis_mm' as const, fromWaterYear: 2012, toWaterYear: 2016 },
		fallback: { series: 'rain_reanalysis_mm' as const, fromWaterYear: 2012, toWaterYear: 2016 },
		reason: 'invented: the gauge moved'
	};

	it('factor = (catchment ÷ ref, era) ÷ (alt ÷ ref, period) = 2 / 0.8; the alt gap takes reanalysis × 2', () => {
		const out = runModel(catchment(series, { rainSource: [period] }));
		const info = out.summary.rainSource!.periods[0]!;
		for (const f of info.factors) expect(f).toBeCloseTo(2.5, 12);
		const used = col(out, 'rain_used')!;
		const t = p0 + 5 - d0;
		expect(used[t]).toBeCloseTo(0.8 * ref(p0 + 5) * 2.5, 12);
		const g = p0 + 40 - d0;
		expect(used[g]).toBeCloseTo(2 * ref(p0 + 40), 12);
		expect(col(out, 'rain_source')![g]).toBe(3);
		expect(info.seriesDays + info.chirpsDays + info.reanalysisDays + info.forecastDays + info.noneDays).toBe(info.runDays);
		expect(info.reanalysisDays).toBe(1);
	});

	it('a period quantile map keeps every year-month total of the scaled series', () => {
		// A wet-day-rich invented record so each month has ≥ 30 wet days on both sides.
		const wet = (d: number) => (((d % 3) + 3) % 3 === 0 ? 0 : 1 + (((d * 7919) % 23) + 23) % 23);
		const pr = days.map((d) => (d >= p0 ? 50 : wet(d)));
		const al = days.filter((d) => d >= p0).map((d) => (((d % 2) + 2) % 2 === 0 ? 0.5 : 4 + (((d * 104729) % 9) + 9) % 9));
		const out = runModel(
			catchment(
				{ rain_catchment_mm: { startDate: fromEpochDay(d0), values: pr }, rain_catchment_alt_mm: { startDate: '2017-10-01', values: al } },
				{
					rainSource: [
						{
							start: '2017-10-01',
							end: '2018-09-30',
							series: 'rain_catchment_alt_mm',
							factors: new Array(12).fill(1.25),
							provenance: { source: 'invented', fittedFrom: '2012-10-01', fittedTo: '2017-09-30', method: 'invented' },
							quantileMap: { fromWaterYear: 2012, toWaterYear: 2016, wetDayMm: 1 },
							reason: 'invented'
						}
					]
				}
			)
		);
		const used = col(out, 'rain_used')!;
		// Year-month totals = 1.25 × alt total.
		const byMonth = new Map<string, [number, number]>();
		days.forEach((d, i) => {
			if (d < p0) return;
			const k = fromEpochDay(d).slice(0, 7);
			const v = byMonth.get(k) ?? [0, 0];
			v[0] += used[i]!;
			v[1] += 1.25 * al[d - p0]!;
			byMonth.set(k, v);
		});
		for (const [, [a, b]] of byMonth) expect(a).toBeCloseTo(b, 8);
		expect(out.summary.rainSource!.periods[0]!.quantileMap!.mappedDays).toBeGreaterThan(0);
	});
});

describe('CHIRPS quantile map at its extremes', () => {
	const days = span('2014-10-01', '2019-09-30');
	const d0 = days[0]!;
	const pattern = (d: number) => (((d % 4) + 4) % 4 === 0 ? 14 : 0);
	const chirps = (d: number) => (((d % 4) + 4) % 4 === 0 ? 7 : 2.5);

	it('a gap month with a CHIRPS day far above the fitted range, a month of ties, and an all-zero month all keep their totals', () => {
		const g0 = toEpochDay('2019-01-01');
		const g1 = toEpochDay('2019-03-31');
		const c: (number | null)[] = days.map((d) => (d >= g0 && d <= g1 ? null : pattern(d)));
		const ch: number[] = days.map(chirps);
		ch[toEpochDay('2019-01-15') - d0] = 300; // beyond any fitted value
		for (let d = toEpochDay('2019-02-01'); d <= toEpochDay('2019-02-28'); d++) ch[d - d0] = 4; // every day tied
		for (let d = toEpochDay('2019-03-01'); d <= toEpochDay('2019-03-31'); d++) ch[d - d0] = 0; // all zero
		const series = { rain_catchment_mm: { startDate: fromEpochDay(d0), values: c as never }, rain_chirps_mm: { startDate: fromEpochDay(d0), values: ch } };
		const off = runModel(catchment(series));
		const on = runModel(catchment(series, { chirpsQuantileMap: { wetDayMm: 1 } }));
		const sum = (o: ModelOutput, a: string, b: string) =>
			col(o, 'rain_used')!.slice(toEpochDay(a) - d0, toEpochDay(b) - d0 + 1).reduce((s, v) => s + v, 0);
		for (const [a, b] of [
			['2019-01-01', '2019-01-31'],
			['2019-02-01', '2019-02-28'],
			['2019-03-01', '2019-03-31']
		] as const) {
			expect(sum(on, a, b)).toBeCloseTo(sum(off, a, b), 8);
		}
		const u = col(on, 'rain_used')!;
		// The extreme day stays the month's wettest.
		const jan = u.slice(g0 - d0, g0 - d0 + 31);
		expect(Math.max(...jan)).toBe(jan[14]);
		for (const v of u) expect(Number.isFinite(v)).toBe(true);
		// A month of ties: every day maps to the same value.
		const feb = u.slice(toEpochDay('2019-02-01') - d0, toEpochDay('2019-02-28') - d0 + 1);
		for (const v of feb) expect(v).toBeCloseTo(feb[0]!, 12);
	});
});

describe('rain summaries agree with the daily rain used', () => {
	it('zero-run filled mm and CHIRPS fallback counts match the days', () => {
		const days = span('2015-10-01', '2020-09-30');
		const d0 = days[0]!;
		const h = (d: number) => {
			const m = Number(fromEpochDay(d).slice(5, 7));
			return m >= 11 || m <= 3 ? 3 + (d % 5) : 0.5;
		};
		const z0 = toEpochDay('2018-12-01');
		const z1 = toEpochDay('2019-02-20');
		const c: (number | null)[] = days.map((d) => (d >= z0 && d <= z1 ? 0 : 1.3 * h(d)));
		for (let k = 0; k < 10; k++) c[100 + k] = null; // a blank stretch
		const out = runModel(catchment({ rain_catchment_mm: { startDate: fromEpochDay(d0), values: c as never }, rain_chirps_mm: { startDate: fromEpochDay(d0), values: days.map(h) } }));
		const used = col(out, 'rain_used')!;
		const miss = col(out, 'rain_catchment_missing')!;
		const src = col(out, 'rain_source')!;
		const zr = out.summary.zeroRainInfill!;
		let filled = 0;
		let masked = 0;
		for (let t = 0; t < used.length; t++) if (miss[t] === 1) {
			filled += used[t]!;
			masked++;
		}
		expect(zr.days).toBe(masked);
		expect(zr.filledMm).toBeCloseTo(filled, 8);
		const corr = out.summary.chirpsCorrection!;
		const chirpsDays = src.filter((v) => v === 2).length;
		expect(corr.fallbackDays).toBe(chirpsDays);
		expect(chirpsDays).toBe(masked + 10);
	});
});
