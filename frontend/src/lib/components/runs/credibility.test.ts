import type { RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { credibility, groupUnitsOnCatchmentRain, NO_OWN_RAIN_NAMED, warningGroups, warningItem } from './credibility';
import { calibrationHref } from '#lib/components/calibration/links.js';

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
		// Each item starts with a capital, whatever the engine's text (#586 round 2).
		expect(g.check).toEqual([
			'Farm flow shares sum to 80.00%, not 100% (tolerance ±0.02%): natural flow and EWR are not fully allocated to farms',
			'Simulated natural flow is 30 % above the WR2012 naturalised MAR for X99Z … Query it',
			'A warning the engine adds next year'
		]);
		expect(warningGroups(undefined)).toEqual({ check: [], data: [] });
	});

	it('groups a coded warning by its code (engine ≥ 1.102.0), whatever its text; an uncoded one, or an unknown code, by its text', () => {
		const handled = 'Catchment rain from a reworded note the regexes don’t know';
		const doubted = 'CHIRPS rain bias-corrected on 12 days, but the code says check';
		const future = 'CHIRPS rain bias-corrected on 30 days (a code this page doesn’t know yet)';
		const plain = 'Catchment rain accumulations spread over the days they cover: 1 window';
		const g = warningGroups(
			[handled, doubted, future, plain, 'a warning the engine adds next year'],
			[
				{ code: 'rain.zeroRun.missing', text: handled },
				{ code: 'rain.chirps.uncorrected', text: doubted },
				{ code: 'rain.someday' as never, text: future }
			]
		);
		expect(g.data).toEqual([handled, future, plain]);
		expect(g.check).toEqual([doubted, 'A warning the engine adds next year']);
		// Without codes (a run before 1.102.0) the texts decide, as before.
		expect(warningGroups([handled, doubted], null)).toEqual({ check: [handled], data: [doubted] });
	});

	describe('units with no rain of their own (engine-audit.md FM3)', () => {
		// The engine's texts (runoff/unitRain.ts rule 4), for invented units.
		const noRain = (name: string, tail = '') =>
			`unit rain: "${name}" has no rain of its own (no rain gauge or CHIRPS series of its own, and no MAP to scale the catchment gauge by): it runs on the catchment rain${tail}`;
		const noUsable = (name: string) =>
			`unit rain: "${name}" has no usable rain of its own (its CHIRPS totals 0 mm, no rain gauge of its own, and no MAP to scale the catchment gauge by): it runs on the catchment rain`;
		const other = 'farm flow shares sum to 80.00%, not 100% (tolerance ±0.02%)';

		it('one unit keeps the engine’s sentence', () => {
			expect(warningGroups([other, noRain('Upper farm')]).check).toEqual([warningItem(other), warningItem(noRain('Upper farm'))]);
		});

		it('many units are one thing to check at the first one’s place, counting them all and naming the first 5 by name', () => {
			const names = Array.from({ length: 58 }, (_, i) => `Farm ${58 - i}`); // node-id order isn't name order
			const g = warningGroups([...names.slice(0, 2).map((n) => noRain(n)), other, ...names.slice(2).map((n) => noRain(n))]);
			expect(g.check).toEqual([
				'Unit rain: 58 units have no rain of their own (no rain gauge or CHIRPS series of their own, and no MAP to scale the catchment gauge by), so they run on the catchment rain: "Farm 1", "Farm 2", "Farm 3", "Farm 4", "Farm 5", and 53 more (Rain for each unit names them all)',
				warningItem(other)
			]);
			expect(NO_OWN_RAIN_NAMED).toBe(5);
		});

		it('names every unit when there are no more than 5, keeps the areal correction, and groups 0 mm CHIRPS apart', () => {
			const tail = ' × the areal correction';
			const g = groupUnitsOnCatchmentRain([noRain('C', tail), noUsable('Z2'), noRain('A', tail), noUsable('Z1'), noRain('B', tail)]);
			expect(g).toEqual([
				'unit rain: 3 units have no rain of their own (no rain gauge or CHIRPS series of their own, and no MAP to scale the catchment gauge by), so they run on the catchment rain × the areal correction: "A", "B", "C"',
				'unit rain: 2 units have no usable rain of their own (their CHIRPS totals 0 mm, no rain gauge of their own, and no MAP to scale the catchment gauge by), so they run on the catchment rain: "Z1", "Z2"'
			]);
		});

		it('leaves the other unit rain warnings, and a name with quotes in it, alone', () => {
			const fell = 'unit rain: "Upper farm" ran 3 of its 120 days on the catchment\'s rain, where its station and its patching sources had no value';
			expect(groupUnitsOnCatchmentRain([fell, noRain('The "big" farm'), noRain('B')])).toEqual([fell, expect.stringContaining('2 units have no rain of their own') as unknown as string]);
			expect(groupUnitsOnCatchmentRain([noRain('The "big" farm'), noRain('B')])[0]).toContain(': "B", "The "big" farm"');
		});
	});

	it('gives every code the group its text gave before codes, where the regexes knew the text', () => {
		// The engine's own texts for each code DATA_NOTES matches (synthetic figures): a code never moves a warning.
		const cases: [string, string][] = [
			['rain.chirps.corrected', 'CHIRPS rain bias-corrected on 120 days where catchment rain is blank (300 mm raw → 330 mm): factor …'],
			['rain.zeroRun.missing', 'Catchment rain treated as missing on 90 days: 1 Jun 2019 to 15 Aug 2019 (76 days, flagged zero run). …'],
			['rain.accumulation.spread', 'Catchment rain accumulations spread over the days they cover: 1 window, 21 run days: …'],
			['data.zerorun', 'Rainfall (catchment): 1 run of zero rain covering 60 or more days in the wet half of the year: …'],
			['data.flatline', 'Rainfall (catchment): 1 flat stretch of 10 or more days with the same value (…). A stuck logger or a filled-in gap?']
		];
		for (const [code, text] of cases) {
			expect(warningGroups([text]).data, code).toHaveLength(1);
			expect(warningGroups([text], [{ code: code as never, text }]).data, code).toHaveLength(1);
		}
	});
});

describe('credibility', () => {
	const checks = (failed: number) => ({ passed: failed === 0, checks: Array.from({ length: 5 }, (_, i) => ({ label: `c${i}`, passed: i >= failed, detail: '' })) });

	it('reads the self-checks, the fit, plausibility and WR2012, each linking to its panel: Model quality’s on Calibration (issue #586)', () => {
		const summary = {
			verification: checks(0),
			plausibility: {
				naturalised: { judgedYears: 10, failedYears: [2015] },
				rainSource: null,
				flowDoubleMass: { breaks: [] },
				lowFlow: { comparison: { withinFactor: true } }
			},
			wr2012: { flag: { level: 'note' } },
			calibration: { days: 400, nse: 0.712, pbias: -12.34, fitStatus: 'fitted' }
		} as unknown as Parameters<typeof credibility>[0];
		// The fit has no verdict (issue #177): its scores, untoned, in the Summary's words (PBIAS −12.3 is 12.3% too wet).
		expect(credibility(summary).map((i) => [i.label, i.text, i.tone, i.href])).toEqual([
			['Arithmetic checks', 'all 5 passed', 'ok', '#res-checks'],
			['Calibration', 'NSE 0.71, volume bias 12.3% too wet', 'none', '?tab=calibration#res-calibration'],
			['Plausibility', '1 of 3 checks found something', 'warn', '?tab=calibration#res-plausibility'],
			['WR2012', 'Note the difference', 'warn', '?tab=calibration#res-wr2012']
		]);
		// The workspace's links keep the run shown.
		expect(credibility(summary, (a) => calibrationHref('r 1', a)).map((i) => i.href)).toEqual([
			'#res-checks',
			'?tab=calibration&run=r%201#res-calibration',
			'?tab=calibration&run=r%201#res-plausibility',
			'?tab=calibration&run=r%201#res-wr2012'
		]);
	});

	it('flags a fit no better than the mean flow, and says when the run scored none (#586 D12)', () => {
		const item = (calibration: unknown) => credibility({ calibration } as unknown as Parameters<typeof credibility>[0]).find((i) => i.label === 'Calibration')!;
		expect([item({ days: 400, nse: -0.2, pbias: null }).text, item({ days: 400, nse: -0.2, pbias: null }).tone]).toEqual(['NSE −0.20, no better than the mean flow', 'warn']);
		expect([item({ days: 0, nse: 0, pbias: 0 }).text, item(null).tone]).toEqual(['not scored: no observed flow in the run', 'none']);
	});

	it('counts the hydrological signatures (engine ≥ 1.55.0) among the plausibility findings', () => {
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
		expect(items.map((i) => [i.label, i.text, i.tone])).toEqual([
			['Arithmetic checks', '2 of 5 failed', 'bad'],
			['Calibration', 'not scored: no observed flow in the run', 'none']
		]);
	});
});
