import { describe, expect, it } from 'vitest';
import {
	agreementOptions,
	agreementWarning,
	areaMismatches,
	areaMismatchWarning,
	checkSeries,
	FLATLINE_MIN_DAYS,
	observedAgreement,
	resolveDataQuality,
	seriesChecks,
	waterYearLabel
} from './quality';
import { defaultProjectSettings, type NetworkNode } from './project';

// 1 m³/s for one day = 0.0864 Mm³.
const constant = (startDate: string, days: number, v: number | null) => ({ startDate, values: new Array(days).fill(v) });

describe('observedAgreement', () => {
	it('returns null unless both observed records exist and overlap', () => {
		expect(observedAgreement({ flow_observed_m3s: constant('2020-10-01', 10, 1) })).toBeNull();
		expect(
			observedAgreement({ flow_observed_m3s: constant('2020-10-01', 10, 1), flow_logger_m3s: constant('2021-10-01', 10, 1) })
		).toBeNull();
	});

	it('sums volumes per water year on shared days only and flags out-of-band years', () => {
		// Water year 2020 (Oct 2020 – Sep 2021): gauge 1, logger 1 → agree.
		// Water year 2021: gauge 0.1, logger 1 → 10 %, flagged.
		const gauge = { startDate: '2020-10-01', values: [...new Array(365).fill(1), ...new Array(365).fill(0.1)] };
		const logger = { startDate: '2020-10-01', values: new Array(730).fill(1) };
		// a gap in the logger: those gauge days must not count
		logger.values[10] = null;
		const ag = observedAgreement({ flow_observed_m3s: gauge, flow_logger_m3s: logger })!;
		expect(ag.years.map((y) => y.waterYear)).toEqual([2020, 2021]);
		expect(ag.years[0]).toMatchObject({ days: 364, flagged: false });
		expect(ag.years[0]!.ratio).toBeCloseTo(1, 12);
		expect(ag.years[0]!.volumeAMm3).toBeCloseTo(364 * 0.0864, 9);
		expect(ag.years[1]!.ratio).toBeCloseTo(0.1, 12);
		expect(ag.flaggedYears).toEqual([2021]);
		expect(agreementWarning(ag)).toMatch(/observed gauge flow as a share of the logger flow volume .*: 2021\/22: 10 %\./);
	});

	it('flags too-high ratios and ignores years with too few shared days', () => {
		const ag = observedAgreement(
			{ flow_observed_m3s: constant('2020-10-01', 60, 3), flow_logger_m3s: constant('2020-10-01', 60, 1) },
			{ minDays: 90 }
		)!;
		expect(ag.years[0]!.ratio).toBeCloseTo(3, 12);
		expect(ag.flaggedYears).toEqual([]); // only 60 days
		expect(observedAgreement({ flow_observed_m3s: constant('2020-10-01', 100, 3), flow_logger_m3s: constant('2020-10-01', 100, 1) })!.flaggedYears).toEqual([2020]);
	});

	it('flags a year where one record is zero and the other is not', () => {
		const ag = observedAgreement({ flow_observed_m3s: constant('2020-10-01', 100, 1), flow_logger_m3s: constant('2020-10-01', 100, 0) })!;
		expect(ag.years[0]!.ratio).toBeNull();
		expect(ag.flaggedYears).toEqual([2020]);
		expect(agreementWarning(ag)).toMatch(/2020\/21: the logger flow recorded nothing/);
	});

	it('skips negative readings as invalid, like missing days', () => {
		const gauge = constant('2020-10-01', 100, 1);
		const logger = constant('2020-10-01', 100, 1);
		gauge.values[0] = -5;
		logger.values[1] = -0.001;
		const y = observedAgreement({ flow_observed_m3s: gauge, flow_logger_m3s: logger })!.years[0]!;
		expect(y.days).toBe(98);
		expect(y.ratio).toBeCloseTo(1, 12);
	});

	it('handles a single shared day, and series that are empty or entirely missing', () => {
		const one = observedAgreement({ flow_observed_m3s: constant('2020-10-01', 1, 2), flow_logger_m3s: constant('2020-10-01', 1, 1) })!;
		expect(one.years).toEqual([{ waterYear: 2020, days: 1, volumeAMm3: 2 * 0.0864, volumeBMm3: 0.0864, ratio: 2, flagged: false }]);
		expect(observedAgreement({ flow_observed_m3s: constant('2020-10-01', 50, null), flow_logger_m3s: constant('2020-10-01', 50, 1) })).toBeNull();
		expect(observedAgreement({ flow_observed_m3s: { startDate: '2020-10-01', values: [] }, flow_logger_m3s: constant('2020-10-01', 5, 1) })).toBeNull();
		// Both zero all year: nothing to compare, nothing flagged.
		const dry = observedAgreement({ flow_observed_m3s: constant('2020-10-01', 100, 0), flow_logger_m3s: constant('2020-10-01', 100, 0) })!;
		expect(dry.years[0]).toMatchObject({ ratio: null, flagged: false });
	});

	it('puts 29 February in the water year that contains it and splits years on 1 October', () => {
		// 2019-09-30 … 2020-10-01: WY 2018 has 1 day, WY 2019 has 366 (leap), WY 2020 has 1.
		const n = 368;
		const ag = observedAgreement({ flow_observed_m3s: constant('2019-09-30', n, 1), flow_logger_m3s: constant('2019-09-30', n, 1) })!;
		expect(ag.years.map((y) => [y.waterYear, y.days])).toEqual([
			[2018, 1],
			[2019, 366],
			[2020, 1]
		]);
	});

	it('uses the thresholds it is given, including the minimum shared days', () => {
		const s = { flow_observed_m3s: constant('2020-10-01', 100, 0.8), flow_logger_m3s: constant('2020-10-01', 100, 1) };
		expect(observedAgreement(s)!.flaggedYears).toEqual([]); // 80 % is inside 2/3 … 3/2
		expect(observedAgreement(s, { minRatio: 0.9, maxRatio: 1.1, minDays: 90 })!.flaggedYears).toEqual([2020]);
		expect(observedAgreement(s, { minRatio: 0.9, maxRatio: 1.1, minDays: 101 })!.flaggedYears).toEqual([]);
		const ag = observedAgreement(s, agreementOptions({ agreementMinRatio: 0.9, agreementMaxRatio: 1.1, agreementMinDays: 30 }))!;
		expect([ag.minRatio, ag.maxRatio, ag.minDays]).toEqual([0.9, 1.1, 30]);
		expect(agreementWarning(ag)).toMatch(/expected 90–110 %\): 2020\/21: 80 %/);
		expect(() => observedAgreement(s, { minRatio: 2, maxRatio: 1.5 })).toThrow(RangeError);
		expect(() => observedAgreement(s, { minRatio: 0 })).toThrow(RangeError);
	});

	it('shows a tiny ratio as <1 %, not 0 %', () => {
		const ag = observedAgreement({ flow_observed_m3s: constant('2020-10-01', 100, 0.001), flow_logger_m3s: constant('2020-10-01', 100, 1) })!;
		expect(agreementWarning(ag)).toMatch(/2020\/21: <1 %/);
	});

	it('labels water years', () => {
		expect(waterYearLabel(2016)).toBe('2016/17');
		expect(waterYearLabel(1999)).toBe('1999/00');
	});
});

describe('resolveDataQuality', () => {
	it('defaults to 2/3 … 3/2 on 90 shared days', () => {
		expect(resolveDataQuality(undefined)).toEqual({ agreementMinRatio: 2 / 3, agreementMaxRatio: 1.5, agreementMinDays: 90 });
		expect(resolveDataQuality(undefined)).toEqual(defaultProjectSettings().dataQuality);
	});

	it('keeps valid values and replaces each invalid one with its default, with a warning', () => {
		expect(resolveDataQuality({ agreementMinRatio: 0.5, agreementMaxRatio: 2, agreementMinDays: 30 })).toEqual({
			agreementMinRatio: 0.5,
			agreementMaxRatio: 2,
			agreementMinDays: 30
		});
		const warnings: string[] = [];
		const dq = resolveDataQuality({ agreementMinRatio: 1.2, agreementMaxRatio: 0.5, agreementMinDays: 12.5 }, warnings);
		expect(dq).toEqual(defaultProjectSettings().dataQuality);
		expect(warnings).toHaveLength(3);
		expect(warnings[0]).toMatch(/agreementMinRatio = 1.2 is invalid/);
		for (const bad of [0, -1, NaN, '0.5', Infinity]) {
			const w: string[] = [];
			expect(resolveDataQuality({ agreementMinRatio: bad }, w).agreementMinRatio).toBe(2 / 3);
			expect(w, String(bad)).toHaveLength(1);
		}
		expect(resolveDataQuality({ agreementMinDays: 367 }).agreementMinDays).toBe(90);
		expect(resolveDataQuality('nonsense')).toEqual(defaultProjectSettings().dataQuality);
	});
});

describe('checkSeries', () => {
	// Deterministic "rain": wet every third day, 1–20 mm.
	const rain = (days: number) => Array.from({ length: days }, (_, i) => (i % 3 === 0 ? 1 + ((i * 7) % 20) : 0));

	it('finds nothing wrong with clean data, a single day, empty or all-missing series', () => {
		expect(checkSeries('rain_catchment_mm', { startDate: '2020-01-01', values: rain(1000) })).toEqual([]);
		expect(checkSeries('flow_observed_m3s', { startDate: '2020-01-01', values: [] })).toEqual([]);
		expect(checkSeries('flow_observed_m3s', constant('2020-01-01', 400, null))).toEqual([]);
		expect(checkSeries('rain_catchment_mm', { startDate: '2020-01-01', values: [3] })).toEqual([]);
	});

	it('reports negative values with their dates', () => {
		const v = rain(20);
		v[4] = -2;
		const [c] = checkSeries('rain_catchment_mm', { startDate: '2020-02-27', values: v });
		expect(c).toMatchObject({ check: 'negative', days: 1, examples: [{ date: '2020-03-02', value: -2 }] });
		expect(c!.text).toMatch(/^Rainfall \(catchment\): 1 negative value \(2020-03-02: -2 mm\)/);
	});

	it('flags values far above the 99th percentile, largest first, once there are enough wet days', () => {
		const v: (number | null)[] = rain(1000);
		v[10] = 900; // a typo
		v[20] = 1200;
		const [c] = checkSeries('rain_catchment_mm', { startDate: '2020-01-01', values: v });
		expect(c).toMatchObject({ check: 'outlier', days: 2 });
		expect(c!.examples.map((e) => e.value)).toEqual([1200, 900]);
		expect(c!.text).toMatch(/2 days above 5× the 99th percentile/);
		// Too few positive values to judge: no outlier check.
		expect(checkSeries('rain_catchment_mm', { startDate: '2020-01-01', values: [...rain(90), 5000] })).toEqual([]);
		// Flow uses the wider factor: 6× the P99 is not an outlier, 20× is.
		const flow = Array.from({ length: 500 }, (_, i) => 1 + (i % 10) / 10);
		expect(checkSeries('flow_observed_m3s', { startDate: '2020-01-01', values: [...flow, 12] })).toEqual([]);
		expect(checkSeries('flow_observed_m3s', { startDate: '2020-01-01', values: [...flow, 40] })[0]).toMatchObject({ check: 'outlier', days: 1 });
	});

	it('flags long stretches of one non-zero value, ignores zeros and missing days, and skips Pitman flow', () => {
		const n = FLATLINE_MIN_DAYS.flow_logger_m3s!;
		const v: (number | null)[] = [1, 2, ...new Array(n).fill(0.35), 3, ...new Array(n - 1).fill(0.5), ...new Array(200).fill(0), null, null];
		const [c] = checkSeries('flow_logger_m3s', { startDate: '2021-01-01', values: v });
		expect(c).toMatchObject({ check: 'flatline', days: n, examples: [{ date: '2021-01-03', value: 0.35, runDays: n }] });
		expect(c!.text).toMatch(/1 flat stretch of 14 or more days/);
		expect(checkSeries('flow_pitman_m3s', { startDate: '2021-01-01', values: v })).toEqual([]);
		// Rain: five identical wet days in a row.
		expect(checkSeries('rain_chirps_mm', { startDate: '2021-01-01', values: [0, 4.2, 4.2, 4.2, 4.2, 4.2, 0] })[0]).toMatchObject({
			check: 'flatline',
			days: 5
		});
	});

	it('seriesChecks runs every present series in kind order', () => {
		const bad = { startDate: '2020-01-01', values: [-1] };
		expect(seriesChecks({ flow_logger_m3s: bad, rain_catchment_mm: bad }).map((c) => c.seriesKind)).toEqual(['rain_catchment_mm', 'flow_logger_m3s']);
	});
});

describe('areaMismatches (engine-review F7)', () => {
	const farm = (id: string, areaKm2: number, hi: number, lo: number, kind: NetworkNode['kind'] = 'farm'): NetworkNode => ({
		id,
		name: id,
		kind,
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2,
		areaHiKm2: hi,
		areaLoKm2: lo,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		returnFlowPct: 0
	});

	it('flags a difference over 1 % and passes one under it', () => {
		// 29.3 vs 29.395 is 0.32 %: fine. 10 vs 10.2 is 1.96 %: flagged. Gauges are ignored.
		const nodes = [farm('ok', 29.3, 20, 9.395), farm('off', 10, 8, 2.2), farm('g', 5, 0, 1, 'gauge')];
		const m = areaMismatches(nodes, 'area');
		expect(m.map((x) => x.nodeId)).toEqual(['off']);
		expect(m[0]!.difference).toBeCloseTo(0.2 / 10.2, 12);
		expect(areaMismatchWarning(m)).toMatch(/more than 1 % \(off: 10 km² vs 10.2 km²\)/);
		expect(areaMismatchWarning([])).toBeNull();
	});

	it('skips farms without a hi/lo split unless the hi/lo method is used', () => {
		const nodes = [farm('plain', 12, 0, 0), farm('empty', 0, 0, 0)];
		expect(areaMismatches(nodes, 'area')).toEqual([]);
		expect(areaMismatches(nodes, 'manual')).toEqual([]);
		expect(areaMismatches(nodes, 'hiLo').map((x) => x.nodeId)).toEqual(['plain']);
	});
});

describe('quality checks do not depend on the local time zone', () => {
	it('gives identical results at UTC+14 and UTC−11', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const v: (number | null)[] = Array.from({ length: 800 }, (_, i) => (i % 3 === 0 ? 1 + (i % 17) : 0));
		v[59] = -1;
		v[400] = 9000;
		const series = {
			rain_catchment_mm: { startDate: '2019-12-31', values: v },
			flow_observed_m3s: { startDate: '2019-09-30', values: new Array(800).fill(1) },
			flow_logger_m3s: { startDate: '2019-09-30', values: new Array(800).fill(2) }
		};
		const both = () => JSON.stringify([seriesChecks(series), observedAgreement(series)]);
		try {
			env.TZ = 'Pacific/Kiritimati';
			const east = both();
			env.TZ = 'Pacific/Pago_Pago';
			const west = both();
			env.TZ = 'UTC';
			expect(east).toBe(both());
			expect(west).toBe(both());
			expect(east).toContain('"date":"2020-02-28"'); // index 59 from 2019-12-31
		} finally {
			env.TZ = tz;
		}
	});
});

// The client catchment: the gauge (G1) reads a fraction of the logger (A1) from
// 2014/15 — the case this check exists for (docs/plan.md, first hydrologist
// question). Skipped when the gitignored client data is absent.
type Fs = { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string };
const fsSpecifier = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsSpecifier)) as Fs;
const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? '.';
const dataDir = ['data/client-catchment', '../data/client-catchment', '../../data/client-catchment']
	.map((p) => `${cwd}/${p}`)
	.find((p) => fs.existsSync(`${p}/project.json`));

describe.skipIf(!dataDir)('observedAgreement on the client catchment (needs data/client-catchment)', () => {
	it('flags the gauge-vs-logger divergence from 2014/15', () => {
		const project = JSON.parse(fs.readFileSync(`${dataDir}/project.json`, 'utf8')) as {
			series: { kind: string; startDate: string; values: (number | null)[] }[];
		};
		const series = Object.fromEntries(project.series.map((s) => [s.kind, s]));
		const ag = observedAgreement(series)!;
		expect(ag.years.find((y) => y.waterYear === 2013)!.flagged).toBe(false); // 83 %
		expect(ag.flaggedYears).toEqual(expect.arrayContaining([2014, 2015, 2016]));
		expect(Math.round(ag.years.find((y) => y.waterYear === 2016)!.ratio! * 100)).toBe(8);
	});
});
