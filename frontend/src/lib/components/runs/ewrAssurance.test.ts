import { assessSite, type EwrAssuranceSite, type EwrRuleTable } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import {
	conditionText,
	describeMethod,
	fdcText,
	fewYears,
	fmtFlow,
	fmtMm3,
	headlineSite,
	highFlowVerdict,
	monthLabel,
	naturalMarLine,
	reserveCellText,
	reserveGrid,
	shareOfRequired,
	sourceLine,
	verdict
} from './ewrAssurance';
import { resultSections } from './sections';

// Synthetic: two water years of 1.5 Mm³ natural flow a month (70 % on the table's curve, 0.75 Mm³ required).
const table: EwrRuleTable = {
	siteNodeId: null,
	source: 'Synthetic table',
	component: 'total',
	unit: 'mcm',
	points: [10, 50, 90],
	ewr: Array.from({ length: 12 }, () => [1.5, 1, 0.5]),
	naturalSource: 'table',
	natural: Array.from({ length: 12 }, () => [3, 2, 1]),
	scale: 1
};
function site(share: (t: number) => number, over: Partial<EwrAssuranceSite> = {}): EwrAssuranceSite {
	const days = 366 + 365;
	const natural = new Float64Array(days).fill(1.5e6 / 31);
	const impacted = natural.map((v, t) => v * share(t));
	return { ...assessSite('2000-10-01', days, { table, nodeId: null, name: 'Outlet gauge', isOutlet: true, natural, impacted }).report, ...over };
}

describe('headlineSite', () => {
	it('prefers the outlet, else the first site, else none', () => {
		const out = site(() => 1);
		const g = { ...out, nodeId: 'g', name: 'Gauge', isOutlet: false };
		expect(headlineSite({ ewrAssurance: [g, out] })).toBe(out);
		expect(headlineSite({ ewrAssurance: [g] })).toBe(g);
		expect(headlineSite({})).toBeNull();
	});
});

describe('verdict and method', () => {
	it('says how many months were met', () => {
		expect(verdict(site(() => 1))).toBe('Met in every one of the 24 complete months.');
		expect(verdict(site(() => 0.1))).toBe('Not met in any of the 24 complete months.');
		// The first October at 40 %: 0.6 of 0.75 Mm³.
		expect(verdict(site((t) => (t < 31 ? 0.4 : 1)))).toBe('Met in 23 of 24 months (95.8%); not met in 1.');
		expect(verdict(site(() => 1, { overall: { months: 0, met: 0, rate: null, deficitM3: 0, longestNotMetRun: 0, meanShortfallPct: null } }))).toBe(
			'Not assessed: the run has no complete calendar month.'
		);
	});
	it('describes the method in one sentence', () => {
		expect(describeMethod(site(() => 1))).toBe(
			'Each month’s requirement is the EWR at the % point its natural flow sits at (percentile from the table’s natural flows); table in Mm³ per month, total flow (low and high flows).'
		);
		expect(describeMethod(site(() => 1, { naturalSource: 'run', unit: 'm3s', component: 'lowFlow', scale: 0.25 }))).toBe(
			'Each month’s requirement is the EWR at the % point its natural flow sits at (percentile from the run’s own natural flow at the site); table in m³/s, the month’s mean, low flows only, scaled × 0.25.'
		);
	});
});

describe('naturalMarLine (engine ≥ 1.11.0)', () => {
	it('is null without the determination’s natural MAR, and flags a gap beyond ±15 % only with the percentile from the run', () => {
		expect(naturalMarLine({ naturalSource: 'run' })).toBeNull();
		const wet = { runMcm: 12, tableMcm: 10, differencePct: 20 };
		expect(naturalMarLine({ naturalSource: 'run', naturalMar: wet })).toEqual({
			text: "Natural MAR at the site: 12.0 Mm³/a in this run, 20 % above the determination's 10.0 Mm³/a: beyond ±15 %, so the percentiles from the run may pass or fail months the determination's own curve would not.",
			caution: true
		});
		expect(naturalMarLine({ naturalSource: 'table', naturalMar: wet })).toEqual({
			text: "Natural MAR at the site: 12.0 Mm³/a in this run, 20 % above the determination's 10.0 Mm³/a.",
			caution: false
		});
		expect(naturalMarLine({ naturalSource: 'run', naturalMar: { runMcm: 8.5, tableMcm: 10, differencePct: -15 } })!.caution).toBe(false);
		expect(naturalMarLine({ naturalSource: 'run', naturalMar: { runMcm: 10, tableMcm: 10, differencePct: 0 } })!.text).toBe(
			"Natural MAR at the site: 10.0 Mm³/a in this run, the same as the determination's 10.0 Mm³/a."
		);
	});
});

describe('sourceLine (engine ≥ 1.5.0)', () => {
	it('puts the confidence before the source, and marks a desktop estimate', () => {
		expect(sourceLine(site(() => 1))).toEqual({ text: 'Source: Synthetic table', low: false });
		expect(sourceLine({ source: 'GN 1 of 2000', sourceKind: 'gazetted' })).toEqual({ text: 'Gazetted Reserve: GN 1 of 2000', low: false });
		expect(sourceLine({ source: 'DRM run', sourceKind: 'desktop' })).toEqual({ text: 'Desktop estimate, low confidence: DRM run', low: true });
		expect(sourceLine({ source: 'Study', sourceKind: 'other' })).toEqual({ text: 'Other source, confidence not stated: Study', low: false });
	});
	it('carries the table’s kind from the run', () => {
		const days = 366 + 365;
		const natural = new Float64Array(days).fill(1.5e6 / 31);
		const r = assessSite('2000-10-01', days, { table: { ...table, sourceKind: 'desktop' }, nodeId: null, name: 'O', isOutlet: true, natural, impacted: natural }).report;
		expect(sourceLine(r).text).toBe('Desktop estimate, low confidence: Synthetic table');
	});
});

describe('formatting', () => {
	it('shows flows to about three significant figures', () => {
		expect(fmtFlow(123.4)).toBe('123');
		expect(fmtFlow(12.34)).toBe('12.3');
		expect(fmtFlow(1.234)).toBe('1.23');
		expect(fmtFlow(0.01234)).toBe('0.0123');
		expect(fmtFlow(0)).toBe('0');
		expect(fmtFlow(null)).toBe('–');
	});
	it('shows a small monthly volume in Mm³ to two significant figures, never 0.000 (issue #45)', () => {
		expect(fmtMm3(1_234_567)).toBe('1.235');
		expect(fmtMm3(420)).toBe('0.00042');
		expect(fmtMm3(0)).toBe('0.000');
	});
	it('labels months, conditions, shares and FDC checks', () => {
		const s = site((t) => (t < 31 ? 0.4 : 1));
		const oct = s.months[0]!;
		expect(monthLabel(oct)).toBe('Oct 2000');
		expect(conditionText(oct)).toBe('70 %');
		expect(conditionText({ percentile: 10, beyond: 'wetter' })).toBe('wetter than 10 %');
		expect(conditionText({ percentile: 99, beyond: 'drier' })).toBe('drier than 99 %');
		expect(conditionText({ percentile: 62.5, beyond: null })).toBe('62.5 %');
		expect(shareOfRequired(oct)).toBe('80%');
		expect(shareOfRequired({ required: 0, actual: 1 })).toBe('–');
		expect(fdcText(s.byMonth[0]!.fdc)).toBe('3 of 3');
		expect(fdcText([{ met: null }])).toBe('–');
	});
	it('flags a record shorter than the threshold', () => {
		expect(fewYears(site(() => 1), 10)).toBe(2);
		expect(fewYears(site(() => 1), 2)).toBeNull();
	});
});

describe('resultSections', () => {
	it('no longer lists Reserve compliance on Runs & results: it moved to River & reserve (issue #17)', () => {
		const base = { farms: [], runoff: undefined, wr2012: undefined };
		expect(resultSections(base).map((s) => s.id)).not.toContain('res-reserve');
		expect(resultSections({ ...base, ewrAssurance: [site(() => 1)] } as typeof base).map((s) => s.id)).not.toContain('res-reserve');
	});
});

describe('the Reserve heat map (engine ≥ 0.33.0)', () => {
	// 1.5 Mm³ natural sits at 70 %: 0.75 Mm³ total and 0.4 Mm³ low flow required. B lets 40 % through Jan–Mar (0.6 Mm³ in Jan).
	const lowTable: EwrRuleTable = { ...table, lowFlow: Array.from({ length: 12 }, () => [1, 0.6, 0.2]) };
	const d0 = Date.UTC(2000, 9, 1) / 86_400_000;
	const dry = (t: number) => ([1, 2, 3].includes(new Date((d0 + t) * 86_400_000).getUTCMonth() + 1) ? 0.4 : 1);
	const withLow = (share: (t: number) => number) => {
		const days = 366 + 365;
		const natural = new Float64Array(days).fill(1.5e6 / 31);
		return assessSite('2000-10-01', days, { table: lowTable, nodeId: null, name: 'O', isOutlet: true, natural, impacted: natural.map((v, t) => v * share(t)) }).report;
	};

	it('lays the months out as water-year rows × Oct … Sep, and names the part that failed', () => {
		const g = reserveGrid(withLow(dry));
		expect(g.waterYears).toEqual([2000, 2001]);
		expect(g.cells[0]!.map((c) => c!.state)).toEqual(['met', 'met', 'met', 'high', 'high', 'high', 'met', 'met', 'met', 'met', 'met', 'met']);
		const jan = g.cells[0]![3]!;
		expect(jan.share).toBeCloseTo(0.6 / 0.75, 9);
		expect(reserveCellText(jan)).toBe('Jan 2001: low flows met, high flows not met, 80% of the requirement');
		// Without a low-flow grid, a month that failed is just not met.
		const plain = reserveGrid(site(dry));
		expect(plain.cells[0]![3]!.state).toBe('low');
		expect(reserveCellText(plain.cells[0]![3]!)).toBe('Jan 2001: not met, 80% of the requirement');
		// Far below: the low flows fail too.
		const worse = reserveGrid(withLow((t) => dry(t) * 0.3));
		expect(reserveCellText(worse.cells[0]![3]!)).toBe('Jan 2001: low flows not met, 24% of the requirement');
	});

	it('leaves the months a part-year run lacks empty', () => {
		const days = 200;
		const natural = new Float64Array(days).fill(1.5e6 / 31);
		const r = assessSite('2000-10-15', days, { table, nodeId: null, name: 'O', isOutlet: true, natural, impacted: natural }).report;
		const g = reserveGrid(r);
		expect(g.cells[0]![0]).toBeNull();
		expect(g.cells[0]![1]!.state).toBe('met');
	});

	it('says how a high-flow component did', () => {
		const h = (years: number, required: number, met: number) => ({ overall: { years, required, met, rate: required ? met / required : null } });
		expect(highFlowVerdict(h(0, 0, 0))).toBe('Not assessed: the run has no complete water year.');
		expect(highFlowVerdict(h(5, 0, 0))).toBe('Not required in any of the 5 water years: natural flow never reached it.');
		expect(highFlowVerdict(h(9, 4, 3))).toBe('Met in 3 of the 4 water years whose natural flow had it (75%).');
		expect(highFlowVerdict(h(9, 1, 1))).toBe('Met in 1 of the 1 water year whose natural flow had it (100%).');
	});
});
