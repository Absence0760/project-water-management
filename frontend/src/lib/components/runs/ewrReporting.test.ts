import { assessSite, type EwrAssuranceSite, type EwrRuleTable } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { dailyHeadline, dailyRows, fdcLines, fdcOverlayChart, matchSite, nmarTile } from './ewrReporting';

// Synthetic: one water year, 1.5 Mm³ of natural flow a month, so R = 0.75 Mm³ (70 % on the table's curve).
const rows = (row: number[]) => Array.from({ length: 12 }, () => [...row]);
const table = (over: Partial<EwrRuleTable> = {}): EwrRuleTable => ({
	siteNodeId: null,
	source: 'Synthetic',
	component: 'total',
	unit: 'mcm',
	points: [10, 50, 90],
	ewr: rows([1.5, 1, 0.5]),
	naturalSource: 'table',
	natural: rows([3, 2, 1]),
	scale: 1,
	...over
});
const start = '2000-10-01';
const d0 = Date.UTC(2000, 9, 1) / 86_400_000;
const days = 365;
const len = (t: number) => {
	const d = new Date((d0 + t) * 86_400_000);
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
};
const natural = Float64Array.from({ length: days }, (_, t) => 1.5e6 / len(t));
/** Present-day flow: `share` of natural, but nothing on the first 10 days of October (met on volume when share ≥ 0.75 × 31/21). */
const site = (share: number, over: Partial<EwrRuleTable> = {}, meta: Partial<Pick<EwrAssuranceSite, 'nodeId' | 'name' | 'isOutlet'>> = {}) =>
	assessSite(start, days, {
		table: table(over),
		nodeId: meta.nodeId ?? null,
		name: meta.name ?? 'Outlet',
		isOutlet: meta.isOutlet ?? true,
		natural,
		impacted: natural.map((v, t) => (t < 10 ? 0 : v * share))
	}).report;

describe('dailyRows and dailyHeadline', () => {
	it('puts the daily % beside the monthly verdict and marks short days a met month hides', () => {
		const s = site(0.8);
		const r = dailyRows(s)!;
		expect(r.map((x) => x.label)).toEqual(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
		// October: 21 days at 0.8 × 1.5 = 1.2 Mm³-rate ≥ 0.75, total 0.81 Mm³, met on volume; its first 10 days are short.
		expect(r[0]).toMatchObject({ monthsMet: '100%', daysNotMet: '10 of 31', timeNotMet: '32.3%', volumeNotMet: '32.3%', hiddenByMonthly: true });
		expect(r[1]).toMatchObject({ monthsMet: '100%', daysNotMet: '0 of 30', timeNotMet: '0.0%', hiddenByMonthly: false });
		expect(dailyHeadline(s)).toBe('Below the day’s requirement on 10 of 365 days (2.7% of the time); 2.7% of the required volume was not delivered.');
	});

	it('says every day met, and gives nothing for a run from before engine 1.19.0', () => {
		const full = assessSite(start, days, { table: table(), nodeId: null, name: 'O', isOutlet: true, natural, impacted: natural }).report;
		expect(dailyHeadline(full)).toBe('Every one of the 365 days met its day’s requirement.');
		const old = structuredClone(full);
		delete old.daily;
		for (const m of old.byMonth) delete m.daily;
		expect(dailyRows(old)).toBeNull();
		expect(dailyHeadline(old)).toBeNull();
	});
});

describe('nmarTile', () => {
	it('gives the EWR as %nMAR, with the low flows when the table has them', () => {
		// 12 × 0.75 = 9 of 18 Mm³: 50 %.
		expect(nmarTile(site(1))).toEqual({ value: '50.0', sub: '9.00 of 18.0 Mm³/a natural MAR at the site' });
		expect(nmarTile(site(1, { lowFlow: rows([0.9, 0.6, 0.3]) }))!.sub).toMatch(/; low flows 30\.0 %$/);
		const old = structuredClone(site(1));
		delete old.ewrPctNmar;
		expect(nmarTile(old)).toBeNull();
	});
});

describe('fdcLines and fdcOverlayChart', () => {
	it('draws natural, present day, the other run and the EWR at the table’s points', () => {
		const a = site(0.8);
		const b = site(0.4);
		const lines = fdcLines(a, 1, { presentLabel: 'Run A', other: { label: 'Scenario', site: b } });
		expect(lines.map((l) => [l.key, l.label])).toEqual([
			['natural', 'Natural'],
			['present', 'Run A'],
			['scenario', 'Scenario'],
			['ewr', 'EWR']
		]);
		// November: one month, natural 1.5, present 1.2, scenario 0.6, EWR 1.5 / 1 / 0.5.
		expect(lines[0]!.values.map((v) => +v!.toFixed(9))).toEqual([1.5, 1.5, 1.5]);
		expect(lines[1]!.values.map((v) => +v!.toFixed(9))).toEqual([1.2, 1.2, 1.2]);
		expect(lines[2]!.values.map((v) => +v!.toFixed(9))).toEqual([0.6, 0.6, 0.6]);
		expect(lines[3]!.values).toEqual([1.5, 1, 0.5]);
		const chart = fdcOverlayChart(lines, a.points, 520, 240);
		expect(chart.paths.map((p) => p.key)).toEqual(['natural', 'present', 'scenario', 'ewr']);
		expect(chart.paths[0]!.d.split(' ')).toHaveLength(3);
		expect(chart.paths[0]!.d.startsWith('M')).toBe(true);
		// Higher flow is higher up: natural above the scenario.
		const yOf = (d: string) => Number(d.split(' ')[0]!.split(',')[1]);
		expect(yOf(chart.paths[0]!.d)).toBeLessThan(yOf(chart.paths[2]!.d));
		expect(chart.xTicks[0]).toEqual({ x: 56, label: '0 %' });
		expect(chart.yTicks.length).toBeGreaterThan(1);
		expect(chart.floored).toBe(false);
	});

	it('leaves out another run on other % points, and a line with no values; floors zero flows', () => {
		const a = site(0.8);
		const other = site(0.4, { points: [20, 50, 80] });
		expect(fdcLines(a, 0, { other: { label: 'B', site: other } }).map((l) => l.key)).toEqual(['natural', 'present', 'ewr']);
		const lines = fdcLines(a, 0);
		// October's present-day curve: one month, so every point is the month's flow (not 0); zero shows when a value is 0.
		const zero = [{ ...lines[1]!, values: [0, 1, null] }];
		const chart = fdcOverlayChart(zero, a.points, 520, 240);
		expect(chart.floored).toBe(true);
		expect(chart.paths[0]!.d.split(' ')).toHaveLength(2);
	});
});

describe('matchSite', () => {
	it('matches the outlet with the outlet, then a gauge by id, then by name', () => {
		const out = site(1);
		const g = site(1, {}, { nodeId: 'g1', name: 'Mid gauge', isOutlet: false });
		const copy = site(1, {}, { nodeId: 'g9', name: ' mid GAUGE', isOutlet: false });
		expect(matchSite(out, [g, out])).toBe(out);
		expect(matchSite(g, [out, g])).toBe(g);
		expect(matchSite(g, [out, copy])).toBe(copy);
		expect(matchSite(g, [out])).toBeNull();
		expect(matchSite(out, undefined)).toBeNull();
	});
});
