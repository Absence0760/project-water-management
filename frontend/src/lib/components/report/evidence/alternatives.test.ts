import { describe, expect, it } from 'vitest';
import { alternativeCellText, alternativeHeading, alternativeLine } from './alternatives';

const days = { id: 'ewrDays', unit: 'days' } as const;

describe('the mitigation alternatives on the evidence report (evidence-26)', () => {
	it('words a cell as the application’s: the value and the run’s own change, or the paired median with its range', () => {
		expect(alternativeCellText(days, { value: 120, change: { run: 4, band: null, bandNote: 'no band: no paired ensemble', worse: null }, notAssessed: null, note: null })).toEqual({
			value: '120 days',
			change: 'run: +4 days',
			sub: 'no band: no paired ensemble',
			notAssessed: null,
			note: null
		});
		const banded = alternativeCellText(days, { value: 120, change: { run: 4, band: { n: 30, p5: 1, p50: 3, p95: 6, min: 0, max: 7 }, bandNote: null, worse: { k: 25, n: 30 } }, notAssessed: null, note: null });
		expect(banded.change).toBe('+3 days');
		expect(banded.sub).toBe('+1 to +6 · run: +4 days');
	});

	it('says why a cell isn’t assessed, and marks one a report lacks', () => {
		expect(alternativeCellText(days, { value: null, change: null, notAssessed: 'Not assessed: another baseline.', note: null }).notAssessed).toBe('Not assessed: another baseline.');
		expect(alternativeCellText(days, undefined).notAssessed).toBe('Not in this report');
	});

	it('heads a column with the label and the scenario, and lines it up in A.2', () => {
		expect(alternativeHeading({ label: 'Smaller dam', scenarioName: 'Rooikloof, smaller' }, 0)).toEqual({ label: 'Smaller dam', sub: 'Alternative 1: “Rooikloof, smaller”' });
		expect(alternativeLine({ runId: 'abcdef0123', runLabel: '', engineVersion: '1.2.3', proposals: 1, assumptions: 0, scenarioName: 'Rooikloof, smaller' })).toBe(
			'“Rooikloof, smaller”, run abcdef01, engine 1.2.3: 1 proposal, 0 baseline assumptions'
		);
	});
});
