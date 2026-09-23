import { describe, expect, it } from 'vitest';
import { agreementWarning, observedAgreement, waterYearLabel } from './quality';

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

	it('labels water years', () => {
		expect(waterYearLabel(2016)).toBe('2016/17');
		expect(waterYearLabel(1999)).toBe('1999/00');
	});
});

// client catchment: the gauge (G1) reads a fraction of the logger (A1) from
// 2014/15 — the case this check exists for (docs/plan.md, first hydrologist
// question). Skipped when the gitignored client data is absent.
type Fs = { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string };
const fsSpecifier = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsSpecifier)) as Fs;
const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? '.';
const dataDir = ['data/client-catchment', '../data/client-catchment', '../../data/client-catchment']
	.map((p) => `${cwd}/${p}`)
	.find((p) => fs.existsSync(`${p}/project.json`));

describe.skipIf(!dataDir)('observedAgreement on client catchment (needs data/client-catchment)', () => {
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
