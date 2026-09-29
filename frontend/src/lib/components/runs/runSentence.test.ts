import { assessSite, type CalibrationStats, type EwrAssuranceSite, type EwrRuleTable, type FarmSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { runSentence, runSentences, type SentenceInput } from './runSentence';

// Synthetic farms and flows only (the repo is public).
const farm = (name: string, fractionSupplied: number): FarmSummary => ({
	nodeId: name.toLowerCase().replace(/\s/g, '-'),
	name,
	avgDemandM3Day: 100,
	avgSuppliedM3Day: 100 * fractionSupplied,
	avgDeficitM3Day: 100 * (1 - fractionSupplied),
	fractionSupplied,
	avgEwrShortfallM3Day: 0,
	daysEwrNotMet: 0
});
const catchment = (ewrDaysNotMet: number, ewrFractionDaysNotMet: number): SentenceInput['catchment'] => ({
	meanNaturalFlowM3Day: 10_000,
	meanSimulatedOutflowM3Day: 8_000,
	ewrDaysNotMet,
	ewrFractionDaysNotMet
});
const cal = (over: Partial<CalibrationStats> = {}): CalibrationStats => ({
	days: 730,
	nse: 0.72,
	pbias: 3.14,
	rmseM3s: 0.1,
	meanObservedM3s: 1,
	meanSimulatedM3s: 0.97,
	...over
});
const base = (over: Partial<SentenceInput> = {}): SentenceInput => ({
	farms: [farm('Ridge farm', 1), farm('Middle farm', 0.97), farm('River farm', 0.96)],
	catchment: catchment(73, 0.1),
	...over
});

// Two water years of monthly flow on a synthetic rule table; `share` scales the impacted flow per day.
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

describe('runSentence: the river', () => {
	it('uses the pragmatic EWR at the outflow gauge when the project has no rule table (and on legacy runs)', () => {
		expect(runSentences(base())[0]).toBe('Flow at the outflow gauge was below the EWR on 10.0% of days (73 days).');
		expect(runSentences(base({ catchment: catchment(0, 0) }))[0]).toBe('Flow at the outflow gauge met the EWR on every day of the run.');
	});

	it('leads with the Reserve rules at the headline site when there is a rule table, as the cards do', () => {
		// The first 100 days at a tenth of natural: the first months fail.
		const s = site((t) => (t < 100 ? 0.1 : 1));
		const o = s.overall;
		expect(o.met).toBeGreaterThan(0);
		expect(o.met).toBeLessThan(o.months);
		const first = runSentences(base({ ewrAssurance: [s] }))[0];
		expect(first).toBe(`The Reserve rules were met in ${((o.met / o.months) * 100).toFixed(1)}% of months at the outlet (${o.met} of ${o.months}).`);
		// The pragmatic EWR stays on its card, not in the sentence.
		expect(runSentence(base({ ewrAssurance: [s] }))).not.toMatch(/of days/);
	});

	it('names a non-outlet site, says "every month" when all are met, and says why when nothing can be assessed', () => {
		const gauge = site(() => 1, { nodeId: 'g', name: 'Upper weir', isOutlet: false });
		expect(runSentences(base({ ewrAssurance: [gauge] }))[0]).toBe('The Reserve rules were met in every month at Upper weir.');
		const none = { ...gauge, overall: { ...gauge.overall, months: 0, met: 0, rate: null } };
		expect(runSentences(base({ ewrAssurance: [none] }))[0]).toBe(
			'The Reserve rules at Upper weir could not be assessed: the run has no complete calendar month.'
		);
	});
});

describe('runSentence: the farms', () => {
	it('says every farm got at least the target when all are fine', () => {
		expect(runSentences(base())[1]).toBe('Every hydrological unit got at least 95% of its demand.');
		expect(runSentences(base({ farms: [farm('Ridge farm', 0.99)] }))[1]).toBe('Ridge farm got at least 95% of its demand.');
	});

	it('counts the short farms and names the lowest, at the table’s precision', () => {
		const farms = [farm('Farm 1', 1), farm('Farm 2', 0.8), farm('Farm 7', 0.62), farm('Farm 9', 0.949)];
		expect(runSentences(base({ farms }))[1]).toBe('3 of 4 hydrological units got less than 95% of their demand; the lowest was Farm 7 at 62.0%.');
		expect(runSentences(base({ farms: [farm('A', 1), farm('B', 0.5)] }))[1]).toBe('1 of 2 hydrological units got less than 95% of its demand: B at 50.0%.');
		expect(runSentences(base({ farms: [farm('A', 0.5), farm('B', 0.7)] }))[1]).toBe(
			'All 2 hydrological units got less than 95% of their demand; the lowest was A at 50.0%.'
		);
		expect(runSentences(base({ farms: [farm('Solo', 0.5)] }))[1]).toBe('Solo got 50.0% of its demand, less than 95%.');
	});

	it('picks the first farm on a tie for lowest', () => {
		const farms = [farm('B', 0.5), farm('A', 0.5), farm('C', 0.9)];
		expect(runSentences(base({ farms }))[1]).toMatch(/the lowest was B at 50\.0%\.$/);
	});

	it('leaves the farms out when the run has none (or a legacy run has no farm list)', () => {
		expect(runSentences(base({ farms: [] }))).toHaveLength(1);
		expect(runSentences(base({ farms: undefined }))).toHaveLength(1);
	});
});

describe('runSentence: calibration', () => {
	it('leaves the fit to the NSE and PBIAS cards (issue #177)', () => {
		// A stored summary carries its calibration; the sentence never repeats it.
		for (const c of [cal({ fitStatus: 'fitted' }), cal({ fitStatus: 'notFitted' }), cal()]) {
			const summary = { ...base(), calibration: c };
			expect(runSentences(summary)).toHaveLength(2);
			expect(runSentence(summary)).not.toMatch(/Calibration|NSE|PBIAS/);
		}
	});
});

describe('runSentence', () => {
	it('joins the sentences in order: river, farms', () => {
		expect(runSentence(base({ farms: [farm('A', 1), farm('B', 0.5)] }))).toBe(
			'Flow at the outflow gauge was below the EWR on 10.0% of days (73 days). 1 of 2 hydrological units got less than 95% of its demand: B at 50.0%.'
		);
	});
});
