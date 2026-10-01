import type { RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { credibility, warningGroups } from './credibility';

describe('warningGroups', () => {
	it('puts how the data were handled under data notes and everything else, unknown texts included, under check', () => {
		const g = warningGroups([
			'CHIRPS rain bias-corrected on 120 days where catchment rain is blank (monthly factors)',
			'farm flow shares sum to 80.00%, not 100% (tolerance ±0.02%): natural flow and EWR are not fully allocated to farms',
			'Catchment rain treated as missing on 90 days: 2019-06-01 to 2019-08-15 (76 days, flagged zero run)',
			'Rainfall (catchment): 1 run of zero rain of 60 or more days (2019-06-01 to 2019-08-15)',
			'Observed flow: 1 flat stretch of 14 or more days with the same value (2014-10-01 …). A stuck logger or a filled-in gap?',
			'Catchment rain accumulations spread over the days they cover: 1 window, 21 run days: 2017-06-05 to 2017-06-26',
			'Simulated natural flow is 30 % above the WR2012 naturalised MAR for X99Z … Query it',
			'a warning the engine adds next year'
		]);
		expect(g.data).toHaveLength(5);
		expect(g.check).toEqual([
			'farm flow shares sum to 80.00%, not 100% (tolerance ±0.02%): natural flow and EWR are not fully allocated to farms',
			'Simulated natural flow is 30 % above the WR2012 naturalised MAR for X99Z … Query it',
			'a warning the engine adds next year'
		]);
		expect(warningGroups(undefined)).toEqual({ check: [], data: [] });
	});
});

describe('credibility', () => {
	const checks = (failed: number) => ({ passed: failed === 0, checks: Array.from({ length: 5 }, (_, i) => ({ label: `c${i}`, passed: i >= failed, detail: '' })) });

	it('reads the self-checks, plausibility and WR2012, each linking to its panel, and not the fit (issue #177)', () => {
		const items = credibility({
			verification: checks(0),
			plausibility: {
				naturalised: { judgedYears: 10, failedYears: [2015] },
				rainSource: null,
				flowDoubleMass: { breaks: [] },
				lowFlow: { comparison: { withinFactor: true } }
			},
			wr2012: { flag: { level: 'note' } },
			calibration: { days: 400, nse: 0.712, fitStatus: 'fitted' }
		} as unknown as Parameters<typeof credibility>[0]);
		expect(items.map((i) => [i.label, i.text, i.tone, i.href])).toEqual([
			['Self-checks', 'all 5 passed', 'ok', '#res-checks'],
			['Plausibility', '1 of 3 checks found something', 'warn', '#res-plausibility'],
			['WR2012', 'Note the difference', 'warn', '#res-wr2012']
		]);
	});

	it('counts the validation signatures (engine ≥ 1.55.0) among the plausibility findings', () => {
		const plausibility = (withinLimit: boolean) => ({
			naturalised: null,
			rainSource: null,
			flowDoubleMass: null,
			lowFlow: { comparison: { withinFactor: true } },
			signatures: { flowKind: 'flow_observed_m3s', baseflow: { withinLimit }, lowFlowFdc: null, recessionHoldout: null }
		});
		const item = (withinLimit: boolean) => credibility({ plausibility: plausibility(withinLimit) } as unknown as Parameters<typeof credibility>[0]).find((i) => i.label === 'Plausibility')!;
		expect([item(false).text, item(false).tone]).toEqual(['1 of 2 checks found something', 'warn']);
		expect([item(true).text, item(true).tone]).toEqual(['no findings (2 checked)', 'ok']);
	});

	it('says a failed self-check in red and leaves out what the run has no panel for', () => {
		const items = credibility({ verification: checks(2) } as unknown as Pick<RunSummary, 'verification' | 'plausibility' | 'wr2012'>);
		expect(items.map((i) => [i.label, i.text, i.tone])).toEqual([['Self-checks', '2 of 5 failed', 'bad']]);
	});
});
