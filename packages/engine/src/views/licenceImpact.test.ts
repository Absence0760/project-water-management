import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { WaterAccountRow } from '../network/reliability';
import type { EwrAssuranceMonth, EwrAssuranceSite } from '../reserve/assurance';
import { describeLicenceImpact, licenceImpactByYearClass, type LicenceImpactRun } from './licenceImpact';

// Synthetic record: nine complete water years 2000/01 … 2008/09 with annual
// natural totals 900 … 8100 m³ (terciles: 2000–02 dry, 2003–05 normal,
// 2006–08 wet), from 1 October 2000. Invented numbers.
const START = '2000-10-01';
const YEARS = 9;
const wyDays = (wy: number) => toEpochDay(`${wy + 1}-10-01`) - toEpochDay(`${wy}-10-01`);
const natTotal = (wy: number) => (wy - 1999) * 900;

function row(wy: number, over: Partial<WaterAccountRow> = {}): WaterAccountRow {
	return {
		waterYear: wy,
		days: wyDays(wy),
		rainM3: null,
		catchmentLossM3: null,
		naturalFlowM3: natTotal(wy),
		rainOnDamsM3: 0,
		groundwaterM3: 0,
		transfersM3: 0,
		inM3: 0,
		landCoverM3: 0,
		unallocatedM3: 0,
		consumptiveIrrigationM3: 0,
		otherUseM3: 0,
		damEvaporationM3: 0,
		streamDepletionM3: 0,
		outflowM3: 0,
		outM3: 0,
		damSeepageM3: 0,
		irrigationSuppliedM3: 0,
		openingStorageM3: 0,
		closingStorageM3: 0,
		storageChangeM3: 0,
		residualM3: 0,
		scaleM3: 0,
		ewr: [],
		...over
	};
}

interface RunSpec {
	/** Consumptive irrigation in a water year. */
	irrigation: (wy: number) => number;
	/** Other users' consumptive use. */
	users?: (wy: number) => number;
	/** Dam evaporation. */
	evap?: (wy: number) => number;
	/** Days below the pragmatic EWR at the start of each year. */
	daysBelow?: (wy: number) => number;
	/** Reserve months not met per year (a rule table at the outlet), or none. */
	monthsNotMet?: (wy: number) => number;
	years?: number;
}

/** A run whose outflow is natural − use − evaporation (no storage), so its water account closes. */
function run(spec: RunSpec): LicenceImpactRun {
	const years = spec.years ?? YEARS;
	const natural: number[] = [];
	const short: number[] = [];
	const rows: WaterAccountRow[] = [];
	for (let i = 0; i < years; i++) {
		const wy = 2000 + i;
		const n = wyDays(wy);
		for (let d = 0; d < n; d++) {
			natural.push(natTotal(wy) / n);
			short.push(d < (spec.daysBelow?.(wy) ?? 0) ? -1 : 0);
		}
		const irr = spec.irrigation(wy);
		const users = spec.users?.(wy) ?? 0;
		const evap = spec.evap?.(wy) ?? 0;
		rows.push(row(wy, { consumptiveIrrigationM3: irr, otherUseM3: users, damEvaporationM3: evap, outflowM3: natTotal(wy) - irr - users - evap }));
	}
	const summary: Record<string, unknown> = { supplyAssurance: { waterAccount: { areaKm2: null, years: rows, total: { ...row(2000), waterYear: null } } } };
	if (spec.monthsNotMet) {
		const months: EwrAssuranceMonth[] = [];
		for (let i = 0; i < years; i++) {
			const wy = 2000 + i;
			for (let m = 0; m < 12; m++) {
				months.push({ year: m < 3 ? wy : wy + 1, month: ((m + 9) % 12) + 1, waterYear: wy, days: 30, natural: 1, percentile: 50, beyond: null, required: 1, actual: 1, met: m >= spec.monthsNotMet(wy), deficitM3: 0 });
			}
		}
		summary.ewrAssurance = [{ nodeId: null, isOutlet: true, months } as unknown as EwrAssuranceSite];
	}
	return {
		startDate: START,
		series: [
			{ nodeId: null, key: 'natural_flow', label: '', unit: 'm³/day', values: natural },
			{ nodeId: null, key: 'ewr_shortfall', label: '', unit: 'm³/day', values: short }
		],
		summary: summary as never
	};
}

const dry = (wy: number) => wy <= 2002;
const wet = (wy: number) => wy >= 2006;

describe('licenceImpactByYearClass: Reserve months', () => {
	// Background: 100 m³ of irrigation a year, 2 Reserve months missed in dry years.
	// Application: 150 m³, 4 months missed in dry years, 1 in normal years, none in wet.
	const background = run({ irrigation: () => 100, evap: () => 10, monthsNotMet: (wy) => (dry(wy) ? 2 : 0) });
	const application = run({ irrigation: () => 150, evap: () => 10, monthsNotMet: (wy) => (dry(wy) ? 4 : wet(wy) ? 0 : 1) });
	const r = licenceImpactByYearClass({ background, application });

	it('classes the background years and counts Reserve months below, baseline vs application', () => {
		expect(r.metric).toBe('reserveMonthsMet');
		expect(r.siteNodeId).toBeNull();
		expect(r.method).toBe('terciles');
		expect(r.classes.map((c) => [c.classId, c.nYears, c.waterYears])).toEqual([
			['dry', 3, [2000, 2001, 2002]],
			['normal', 3, [2003, 2004, 2005]],
			['wet', 3, [2006, 2007, 2008]]
		]);
		expect(r.classes.map((c) => c.below)).toEqual([
			{ units: 36, background: 6, application: 12, change: 6 },
			{ units: 36, background: 0, application: 3, change: 3 },
			{ units: 36, background: 0, application: 0, change: 0 }
		]);
		expect(r.classes.map((c) => c.verdict)).toEqual(['moreBelow', 'moreBelow', 'noChange']);
		expect(r.warnings).toEqual([]);
	});

	it('builds the annual waterfall from the water accounts, mean m³ a year', () => {
		const w = r.classes[0]!.waterfall!;
		// Dry years' natural totals 900, 1800, 2700: mean 1800.
		expect(w.naturalM3).toBeCloseTo(1800, 9);
		expect(w.existingUseM3).toBeCloseTo(100, 9);
		expect(w.proposedM3).toBeCloseTo(50, 9);
		expect(w.leftM3).toBeCloseTo(1800 - 150 - 10, 9);
		expect(w.backgroundLeftM3).toBeCloseTo(1800 - 100 - 10, 9);
		expect(w.otherM3).toBeCloseTo(10, 9);
		expect(w.otherParts.damLossesM3).toBeCloseTo(10, 9);
		for (const c of r.classes) {
			const x = c.waterfall!;
			expect(x.naturalM3 - x.existingUseM3 - x.proposedM3 - x.otherM3).toBeCloseTo(x.leftM3, 9);
		}
	});

	it('counts other water users in the use, and a proposal that uses less as negative', () => {
		const less = licenceImpactByYearClass({
			background: run({ irrigation: () => 100, users: () => 40, monthsNotMet: (wy) => (dry(wy) ? 3 : 0) }),
			application: run({ irrigation: () => 60, users: () => 40, monthsNotMet: (wy) => (dry(wy) ? 1 : 0) })
		});
		const c = less.classes[0]!;
		expect(c.waterfall!.existingUseM3).toBeCloseTo(140, 9);
		expect(c.waterfall!.proposedM3).toBeCloseTo(-40, 9);
		expect(c.verdict).toBe('fewerBelow');
		expect(c.below!.change).toBe(-6);
	});

	it('takes the verdict from the months, not from the annual totals', () => {
		// The same annual use in both runs (so the waterfalls are identical), but the application misses more months.
		const same = licenceImpactByYearClass({
			background: run({ irrigation: () => 100, monthsNotMet: () => 0 }),
			application: run({ irrigation: () => 100, monthsNotMet: (wy) => (wet(wy) ? 2 : 0) })
		});
		const w = same.classes[2]!;
		expect(w.waterfall!.proposedM3).toBe(0);
		expect(w.verdict).toBe('moreBelow');
	});
});

describe('licenceImpactByYearClass: fallbacks', () => {
	it('uses days below the pragmatic EWR without a rule table', () => {
		const r = licenceImpactByYearClass({
			background: run({ irrigation: () => 100, daysBelow: (wy) => (dry(wy) ? 10 : 0) }),
			application: run({ irrigation: () => 200, daysBelow: (wy) => (dry(wy) ? 25 : 0) })
		});
		expect(r.metric).toBe('daysBelowEwr');
		expect(r.classes[0]!.below).toEqual({ units: 365 * 3, background: 30, application: 75, change: 45 });
		expect(r.warnings).toEqual([]);
	});

	it('falls back to days for both runs, with a warning, when only one has the rule table', () => {
		const r = licenceImpactByYearClass({
			background: run({ irrigation: () => 100, monthsNotMet: () => 0 }),
			application: run({ irrigation: () => 100, daysBelow: () => 1 })
		});
		expect(r.metric).toBe('daysBelowEwr');
		expect(r.warnings[0]).toMatch(/Only one of the two runs has a Reserve rule table/);
	});

	it('gives no verdict, waterfall or counts to a class with fewer than 3 years', () => {
		// Six years: two per tercile.
		const r = licenceImpactByYearClass({ background: run({ irrigation: () => 100, years: 6 }), application: run({ irrigation: () => 200, years: 6 }) });
		for (const c of r.classes) {
			expect(c.nYears).toBe(2);
			expect(c.enoughYears).toBe(false);
			expect(c.verdict).toBe('notEnoughYears');
			expect(c.waterfall).toBeNull();
			expect(c.below).toBeNull();
		}
	});

	it('only compares years both runs cover in full', () => {
		const r = licenceImpactByYearClass({ background: run({ irrigation: () => 100 }), application: run({ irrigation: () => 100, years: 7 }) });
		// The application ends after 2006/07: the wet class keeps 2006 only.
		expect(r.classes[2]!.waterYears).toEqual([2006]);
		expect(r.classes[2]!.verdict).toBe('notEnoughYears');
		expect(r.warnings.some((w) => /2 classed water year\(s\) are not covered in full by both runs/.test(w))).toBe(true);
	});

	it('gives the same board under a skewed TZ', () => {
		const tz = process.env.TZ;
		const args = () => ({ background: run({ irrigation: () => 100, monthsNotMet: (wy: number) => (dry(wy) ? 2 : 0) }), application: run({ irrigation: () => 150, monthsNotMet: () => 3 }) });
		const utc = licenceImpactByYearClass(args());
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone;
				expect(licenceImpactByYearClass(args())).toEqual(utc);
			}
		} finally {
			process.env.TZ = tz;
		}
	});

	it('throws when a run has no water account', () => {
		const bare = { ...run({ irrigation: () => 0 }), summary: {} as never };
		expect(() => licenceImpactByYearClass({ background: run({ irrigation: () => 0 }), application: bare })).toThrow(/application run has no water account/);
	});

	it('forces Reserve months at a gauge, and throws when a run has no table there', () => {
		const b = run({ irrigation: () => 0, monthsNotMet: () => 0 });
		expect(() => licenceImpactByYearClass({ background: b, application: b, siteNodeId: 'g1' })).toThrow(/no Reserve rule table at the site/);
	});
});

describe('describeLicenceImpact', () => {
	const r = licenceImpactByYearClass({
		background: run({ irrigation: () => 100, monthsNotMet: (wy) => (dry(wy) ? 3 : wy === 2003 ? 1 : 0) }),
		application: run({ irrigation: () => 150, monthsNotMet: (wy) => (dry(wy) ? 4 : wy === 2003 ? 1 : 0) })
	});

	it('reports the months as data, naming both runs', () => {
		expect(r.classes.map((c) => describeLicenceImpact(r.metric, c, { background: 'the baseline', application: 'this run' }))).toEqual([
			'The Reserve was not met in 3 more months over 3 dry years (9 in the baseline, 12 in this run).',
			'The Reserve was not met in 1 month over 3 normal years in both runs.',
			'The Reserve was met in every month over 3 wet years in both runs.'
		]);
	});

	it('words days, one fewer, and not enough years', () => {
		const days = licenceImpactByYearClass({
			background: run({ irrigation: () => 100, daysBelow: (wy) => (wy === 2000 ? 1 : 0) }),
			application: run({ irrigation: () => 50, daysBelow: () => 0 })
		});
		expect(describeLicenceImpact(days.metric, days.classes[0]!)).toBe('The pragmatic EWR was not met on 1 fewer day over 3 dry years (1 in the background run, 0 in the application).');
		// The daily test by its name when the runs' daily EWR came from a DRM table (engine ≥ 1.77.0).
		expect(describeLicenceImpact(days.metric, days.classes[0]!, { background: 'the background run', application: 'the application', ewr: 'the daily EWR from the DRM TAB file' })).toBe(
			'The daily EWR from the DRM TAB file was not met on 1 fewer day over 3 dry years (1 in the background run, 0 in the application).'
		);
		const few = licenceImpactByYearClass({ background: run({ irrigation: () => 0, years: 4 }), application: run({ irrigation: () => 0, years: 4 }) });
		expect(few.classes.map((c) => describeLicenceImpact(few.metric, c))).toEqual([
			'Only 1 dry year both runs cover: not enough years to judge.',
			'Only 2 normal years both runs cover: not enough years to judge.',
			'Only 1 wet year both runs cover: not enough years to judge.'
		]);
		for (const c of [...r.classes, ...days.classes]) expect(describeLicenceImpact(r.metric, c)).not.toMatch(/recommend|should|likely/i);
	});
});
